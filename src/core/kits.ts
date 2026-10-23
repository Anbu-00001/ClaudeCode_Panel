import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { RungId } from "./detect.js";
import { type ClaudePaths, getClaudePaths, type RepoInfo } from "./paths.js";
import {
  atomicWriteFile,
  ccpanelHome,
  DEFAULT_CONTENT_MODE,
  EXECUTABLE_MODE,
  findFencedBlock,
  isExecutable,
  type Operation,
  type RecordedChange,
  runTransaction,
  serializeJson,
  type TransactionResult,
  WriteConflict,
} from "./write.js";

/**
 * Kit loading, preview, install, verify and uninstall (§9).
 *
 * A kit is a directory of plain files plus a manifest. Nothing here executes
 * code from a kit — files are copied and settings are patched, and that is
 * the whole surface.
 */

const installEntrySchema = z.discriminatedUnion("kind", [
  z.looseObject({
    kind: z.literal("hook"),
    name: z.string(),
    from: z.string(),
    to: z.string(),
    executable: z.boolean().optional(),
  }),
  z.looseObject({
    kind: z.literal("skill"),
    name: z.string(),
    from: z.string(),
    to: z.string(),
  }),
  z.looseObject({
    kind: z.literal("subagent"),
    name: z.string(),
    from: z.string(),
    to: z.string(),
  }),
  z.looseObject({
    kind: z.literal("command"),
    name: z.string(),
    from: z.string(),
    to: z.string(),
  }),
  z.looseObject({
    kind: z.literal("script"),
    name: z.string(),
    from: z.string(),
    to: z.string(),
    executable: z.boolean().optional(),
  }),
  z.looseObject({
    kind: z.literal("mcp"),
    name: z.string(),
    scope: z.enum(["project", "user"]),
    server: z.looseObject({
      type: z.string().optional(),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      url: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
    }),
    /**
     * Server entries earlier versions of this kit wrote. An entry matching
     * one of these is the kit's own, so it may be updated in place.
     */
    replaces: z.array(z.record(z.string(), z.unknown())).optional(),
  }),
  z.looseObject({
    kind: z.literal("settings"),
    scope: z.enum(["project", "local", "user"]),
    patch: z.record(z.string(), z.unknown()),
    /**
     * Hook commands earlier versions of this kit wrote. A hook running one of
     * these is the kit's own, so an update replaces it and uninstall removes it.
     */
    replacesCommands: z.array(z.string()).optional(),
  }),
  z.looseObject({
    kind: z.literal("claudemd"),
    blockId: z.string(),
    content: z.string(),
  }),
]);

export const kitSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  blurb: z.string(),
  rung: z.string(),
  requires: z
    .looseObject({
      /** null means we have not verified a minimum — never assert one we did not check. */
      minClaudeVersion: z.string().nullish(),
      git: z.boolean().optional(),
    })
    .optional(),
  installs: z.array(installEntrySchema),
  /** The situation a newcomer is in when they need this (§2). Drives grouping. */
  newcomerProblem: z.string().nullish(),
  /** Kits Claude asked for, rather than ones drawn from the spec. */
  chosenByClaude: z.boolean().optional(),
  whyClaudeWantsThis: z.string().nullish(),
  tryThis: z.string().nullish(),
  tryThisExplain: z.string().nullish(),
  explain: z.string(),
  honestLimit: z.string().nullish(),
  uninstallNote: z.string().nullish(),
});

export type InstallEntry = z.infer<typeof installEntrySchema>;
export type KitManifest = z.infer<typeof kitSchema>;

export interface Kit extends KitManifest {
  rung: RungId;
  /** Directory the kit was loaded from, used to resolve `from` paths. */
  dir: string;
}

export function bundledKitsDir(): string {
  // dist/core/kits.js -> <pkg>/kits ; src/core/kits.ts -> <pkg>/kits
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "kits");
}

export function loadKits(kitsDir: string = bundledKitsDir()): Kit[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(kitsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const kits: Kit[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(kitsDir, entry.name);
    const manifestPath = path.join(dir, "kit.json");
    let raw: string;
    try {
      raw = fs.readFileSync(manifestPath, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // a malformed bundled kit is skipped, never crashes the app
    }
    const result = kitSchema.safeParse(parsed);
    if (!result.success) continue;
    kits.push({ ...result.data, rung: result.data.rung as RungId, dir });
  }

  return kits.sort((a, b) => orderOf(a.id) - orderOf(b.id) || a.id.localeCompare(b.id));
}

/**
 * Hand-curated priority, not a score (§10.1). The deletion warning leads
 * deliberately: it is the most valuable thing here for a beginner, and §9.5
 * requires it to rank first among suggestions when it isn't installed.
 * Kits not listed here sort after the ones that are.
 */
export const KIT_ORDER: string[] = [
  "deletion-warning", // losing work is the worst thing that happens to a beginner
  "safe-permissions", // prompt fatigue is what pushes people to switch checks off
  "code-reviewer",
  "commit-messages",
  "scope-guard",
  "own-mistakes",
  "context-rescue",
  "explore-first",
  "voice-input",
  "browser-testing",
];

function orderOf(id: string): number {
  const i = KIT_ORDER.indexOf(id);
  return i === -1 ? KIT_ORDER.length : i;
}

export function getKit(id: string, kitsDir?: string): Kit | undefined {
  return loadKits(kitsDir).find((k) => k.id === id);
}

// ---------------------------------------------------------------------------
// Where each entry lands
// ---------------------------------------------------------------------------

function settingsPathForScope(paths: ClaudePaths, scope: "project" | "local" | "user"): string {
  if (scope === "user") return paths.userSettings;
  if (scope === "local") return paths.localSettings;
  return paths.projectSettings;
}

export function targetPathFor(_kit: Kit, entry: InstallEntry, repo: RepoInfo): string {
  const paths = getClaudePaths(repo);
  switch (entry.kind) {
    case "settings":
      return settingsPathForScope(paths, entry.scope);
    case "claudemd":
      return paths.projectClaudeMdCandidates[0] as string;
    case "mcp":
      // User scope lives in ~/.claude.json, which v1 never writes (§5.1) —
      // those are handed to `claude mcp add` instead of patched here.
      return paths.projectMcp;
    default:
      return path.join(repo.projectDir, entry.to);
  }
}

/**
 * True when every value a settings patch would add is already present. Used to
 * detect settings-only kits, which leave no file behind to look for.
 */
function settingsPatchApplied(filePath: string, patch: Record<string, unknown>): boolean {
  let settings: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return false;
    settings = parsed as Record<string, unknown>;
  } catch {
    return false;
  }

  for (const [topKey, topValue] of Object.entries(patch)) {
    const current = settings[topKey];

    if (topKey === "permissions" && typeof topValue === "object" && topValue !== null) {
      if (typeof current !== "object" || current === null) return false;
      for (const [listName, values] of Object.entries(topValue as Record<string, unknown>)) {
        if (!Array.isArray(values)) continue;
        const have = (current as Record<string, unknown>)[listName];
        if (!Array.isArray(have)) return false;
        if (!values.every((v) => (have as unknown[]).includes(v))) return false;
      }
      continue;
    }

    if (topKey === "hooks" && typeof topValue === "object" && topValue !== null) {
      if (typeof current !== "object" || current === null) return false;
      for (const [eventName, entries] of Object.entries(topValue as Record<string, unknown>)) {
        if (!Array.isArray(entries)) continue;
        const have = (current as Record<string, unknown>)[eventName];
        if (!Array.isArray(have)) return false;
        for (const ourEntry of entries) {
          const command = extractCommand(ourEntry);
          const matcher = matcherOf(ourEntry);
          if (command && !(have as unknown[]).some((e) => isOurHookEntry(e, command, matcher)))
            return false;
        }
      }
      continue;
    }

    if (JSON.stringify(current) !== JSON.stringify(topValue)) return false;
  }

  return true;
}

/** Kits needing a user-scope MCP server can't be installed by writing files. */
export function requiresUserScopeMcp(kit: Kit): boolean {
  return kit.installs.some((e) => e.kind === "mcp" && e.scope === "user");
}

// ---------------------------------------------------------------------------
// Preview (§9.3) — every file created and every setting changed, before
// anything happens. C5 makes this mandatory.
// ---------------------------------------------------------------------------

export interface PreviewLine {
  op: "create" | "change" | "append";
  /** Path relative to the project, for display. */
  displayPath: string;
  absolutePath: string;
  /** Plain-English description of what this change does for the user. */
  note: string | null;
  /** True when a different file already sits at this path. */
  conflict: boolean;
  /**
   * The exact text going in: each permission rule, each command a hook
   * runs. A summary like "some safe commands" can't be checked; these can.
   */
  details?: string[];
}

export interface KitPreview {
  kit: Kit;
  lines: PreviewLine[];
  conflicts: PreviewLine[];
  /** Full contents of each file, for "Show me the files". */
  files: Array<{ displayPath: string; contents: string; sourcePath?: string }>;
  warnings: string[];
}

function readKitFile(kit: Kit, from: string): string {
  return fs.readFileSync(path.join(kit.dir, from), "utf8");
}

export function previewKit(kit: Kit, repo: RepoInfo): KitPreview {
  const lines: PreviewLine[] = [];
  const files: Array<{ displayPath: string; contents: string; sourcePath?: string }> = [];
  const warnings: string[] = [];

  for (const entry of kit.installs) {
    const absolutePath = targetPathFor(kit, entry, repo);
    const displayPath = path.relative(repo.projectDir, absolutePath) || absolutePath;

    if (entry.kind === "settings") {
      lines.push({
        op: "change",
        displayPath,
        absolutePath,
        note: describeSettingsPatch(entry.patch),
        conflict: false,
        details: settingsPatchDetails(entry.patch),
      });
      continue;
    }

    if (entry.kind === "claudemd") {
      let present = false;
      try {
        present = findFencedBlock(fs.readFileSync(absolutePath, "utf8"), entry.blockId) !== null;
      } catch {
        present = false;
      }
      lines.push({
        op: "append",
        displayPath,
        absolutePath,
        note: present
          ? "already has this section, so it's left as it is"
          : "adds a section, leaving everything already there alone",
        conflict: false,
      });
      files.push({ displayPath, contents: entry.content });
      continue;
    }

    if (entry.kind === "mcp") {
      const current = readMcpServer(absolutePath, entry.name);
      const conflict =
        entry.scope === "project" &&
        current !== undefined &&
        !isKitsOwnServer(entry, current, readMcpLedger()[absolutePath]?.[entry.name]);
      lines.push({
        op: fs.existsSync(absolutePath) ? "change" : "create",
        displayPath,
        absolutePath,
        note: conflict
          ? `you already have a different tool called "${entry.name}" here, so this won't replace it`
          : "tells Claude how to start this tool when it needs it",
        conflict,
        details: [`Starts it with: ${serverCommandLine(entry.server)}`],
      });
      if (entry.scope === "user") {
        warnings.push(
          "This one has to be added with a command instead, because it applies to all your folders.",
        );
      }
      continue;
    }

    let contents = "";
    try {
      contents = readKitFile(kit, entry.from);
    } catch {
      warnings.push(`This kit is missing one of its files (${entry.from}).`);
      continue;
    }

    const olderCopy = isOlderKitCopy(kit, entry.from, absolutePath);
    let conflict = false;
    try {
      if (
        !olderCopy &&
        fs.existsSync(absolutePath) &&
        fs.readFileSync(absolutePath, "utf8") !== contents
      ) {
        conflict = true;
      }
    } catch {
      conflict = false;
    }

    lines.push({
      op: olderCopy ? "change" : "create",
      displayPath,
      absolutePath,
      note: olderCopy
        ? "updates the copy ccpanel put here before to the latest version"
        : entry.kind === "hook"
          ? "runs automatically before Claude uses a tool"
          : null,
      conflict,
    });
    files.push({ displayPath, contents, sourcePath: path.join(kit.dir, entry.from) });
  }

  return { kit, lines, conflicts: lines.filter((l) => l.conflict), files, warnings };
}

const PERMISSION_LIST_LABELS: Record<string, string> = {
  allow: "Runs without asking",
  ask: "Always asks you first",
  deny: "Never allowed",
};

const HOOK_EVENT_LABELS: Record<string, string> = {
  PreToolUse: "before Claude uses a tool",
  PostToolUse: "after Claude uses a tool",
  PreCompact: "before Claude shortens the conversation",
  SessionStart: "when a session starts",
  UserPromptSubmit: "when you send a message",
  Stop: "when Claude finishes answering",
};

/** One line per permission list and per hook, with the exact rules and commands. */
export function settingsPatchDetails(patch: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [topKey, value] of Object.entries(patch)) {
    if (topKey === "permissions" && typeof value === "object" && value !== null) {
      for (const [list, rules] of Object.entries(value as Record<string, unknown>)) {
        if (!Array.isArray(rules) || rules.length === 0) continue;
        out.push(`${PERMISSION_LIST_LABELS[list] ?? list}: ${rules.join(", ")}`);
      }
      continue;
    }
    if (topKey === "hooks" && typeof value === "object" && value !== null) {
      for (const [event, entries] of Object.entries(value as Record<string, unknown>)) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          const command = extractCommand(entry);
          if (!command) continue;
          const matcher = matcherOf(entry);
          const when = HOOK_EVENT_LABELS[event] ?? event;
          out.push(`Runs ${when}${matcher ? ` (${matcher})` : ""}: ${command}`);
        }
      }
      continue;
    }
    out.push(`Sets ${topKey} to ${JSON.stringify(value)}`);
  }
  return out;
}

function serverCommandLine(server: { command?: string; args?: string[]; url?: string }): string {
  if (server.url) return server.url;
  return [server.command ?? "", ...(server.args ?? [])].join(" ").trim();
}

function describeSettingsPatch(patch: Record<string, unknown>): string {
  if ("hooks" in patch) return "lets this run automatically before Claude uses a tool";
  if ("permissions" in patch) return "lets Claude run some safe commands without asking";
  return "changes your setup for this folder";
}

// ---------------------------------------------------------------------------
// Install / uninstall
// ---------------------------------------------------------------------------

/**
 * Identifies one of our hook entries so uninstall removes exactly ours.
 *
 * The matcher is part of the identity, not just the command: a kit may
 * register the same script under several matchers (context-rescue uses both
 * `auto` and `manual`), and matching on command alone would make each entry
 * evict the previous one, leaving only the last.
 */
function isOurHookEntry(entry: unknown, command: string, matcher?: string): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const hooks = (entry as { hooks?: unknown }).hooks;
  if (!Array.isArray(hooks)) return false;
  const commandMatches = hooks.some(
    (h) => typeof h === "object" && h !== null && (h as { command?: unknown }).command === command,
  );
  if (!commandMatches) return false;
  if (matcher === undefined) return true;
  return (entry as { matcher?: unknown }).matcher === matcher;
}

function matcherOf(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const m = (entry as { matcher?: unknown }).matcher;
  return typeof m === "string" ? m : undefined;
}

/**
 * What a plan of operations needs beyond the operations themselves: on
 * install, a place to note which permission values were new (filled in while
 * the transaction runs); on uninstall, exactly which values to take out.
 * Both are keyed by settings file, since one kit may patch more than one.
 */
interface PermissionPlan {
  added: Map<string, PermissionLists>;
  remove: Map<string, PermissionLists>;
}

/** Kit files the user has edited since install, kept rather than deleted. */
interface FilePlan {
  kept: string[];
}

/**
 * Tool (MCP server) entries: what ccpanel has on record as having written,
 * and, during an install, which entries it is writing now.
 */
interface McpPlan {
  ledger: McpLedger;
  written: Array<{ file: string; name: string }>;
}

// ---------------------------------------------------------------------------
// Which tool entries ccpanel wrote
//
// A .mcp.json entry is only a name and a command, so "there is a playwright
// entry" says nothing about who put it there. Install notes each entry it
// writes; uninstall removes only those, and only while they still read the
// way ccpanel wrote them.
// ---------------------------------------------------------------------------

/** .mcp.json path → server name → the server entry ccpanel wrote there. */
type McpLedger = Record<string, Record<string, unknown>>;

export function mcpLedgerPath(): string {
  return path.join(ccpanelHome(), "kit-mcp.json");
}

function readMcpLedger(): McpLedger {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(mcpLedgerPath(), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as McpLedger)
      : {};
  } catch {
    return {};
  }
}

function writeMcpLedger(ledger: McpLedger): void {
  atomicWriteFile(mcpLedgerPath(), serializeJson(ledger));
}

/** JSON equality that ignores key order. */
function sameJson(a: unknown, b: unknown): boolean {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (typeof v === "object" && v !== null) {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * True when a server entry is this kit's own: exactly what it ships now,
 * what an earlier version of it shipped, or what ccpanel recorded writing.
 */
function isKitsOwnServer(
  entry: Extract<InstallEntry, { kind: "mcp" }>,
  current: unknown,
  recorded: unknown,
): boolean {
  if (sameJson(current, entry.server)) return true;
  if ((entry.replaces ?? []).some((old) => sameJson(current, old))) return true;
  return recorded !== undefined && sameJson(current, recorded);
}

function readMcpServer(filePath: string, name: string): unknown {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const servers = (parsed as { mcpServers?: Record<string, unknown> })?.mcpServers;
    return servers && typeof servers === "object" ? servers[name] : undefined;
  } catch {
    return undefined;
  }
}

function buildOperations(
  kit: Kit,
  repo: RepoInfo,
  mode: "install" | "uninstall",
  permissions: PermissionPlan = { added: new Map(), remove: new Map() },
  files: FilePlan = { kept: [] },
  mcp: McpPlan = { ledger: readMcpLedger(), written: [] },
): Operation[] {
  const ops: Operation[] = [];

  for (const entry of kit.installs) {
    const absolutePath = targetPathFor(kit, entry, repo);

    if (entry.kind === "settings") {
      const patch = entry.patch;
      ops.push({
        kind: "patchJson",
        filePath: absolutePath,
        keyPath: [Object.keys(patch)[0] ?? "hooks"],
        mutate: (draft) => {
          const added: PermissionLists = {};
          applySettingsPatch(
            draft,
            patch,
            mode,
            { added, remove: permissions.remove.get(absolutePath) },
            entry.replacesCommands ?? [],
          );
          if (mode === "install") permissions.added.set(absolutePath, added);
        },
      });
      continue;
    }

    if (entry.kind === "claudemd") {
      ops.push(
        mode === "install"
          ? {
              kind: "appendBlock",
              filePath: absolutePath,
              blockId: entry.blockId,
              content: entry.content,
            }
          : { kind: "removeBlock", filePath: absolutePath, blockId: entry.blockId },
      );
      continue;
    }

    if (entry.kind === "mcp") {
      // User scope would mean writing ~/.claude.json, which holds the OAuth
      // session and is known to corrupt under concurrent writes. Skipped here
      // and surfaced as a copyable `claude mcp add` command instead.
      if (entry.scope === "user") continue;
      const recorded = mcp.ledger[absolutePath]?.[entry.name];
      ops.push({
        kind: "patchJson",
        filePath: absolutePath,
        keyPath: ["mcpServers", entry.name],
        mutate: (draft) => {
          const servers = (draft["mcpServers"] as Record<string, unknown>) ?? {};
          const next = { ...servers };
          const current = next[entry.name];
          if (mode === "install") {
            // A tool the user set up themselves under the same name is
            // theirs: never overwrite it.
            if (current !== undefined && !isKitsOwnServer(entry, current, recorded)) {
              throw new WriteConflict(
                `You already have a different tool called "${entry.name}" in ${path.basename(absolutePath)}, so ccpanel left it alone. Rename or remove yours first if you want this one.`,
              );
            }
            if (current === undefined || !sameJson(current, entry.server)) {
              mcp.written.push({ file: absolutePath, name: entry.name });
            }
            next[entry.name] = entry.server;
          } else if (current !== undefined) {
            // Only an entry ccpanel wrote, and still as ccpanel wrote it, is
            // removed. One the user had first, or has changed since, stays.
            if (recorded !== undefined && isKitsOwnServer(entry, current, recorded)) {
              delete next[entry.name];
            } else {
              files.kept.push(`${absolutePath} (the "${entry.name}" tool)`);
            }
          }
          if (Object.keys(next).length > 0) draft["mcpServers"] = next;
          else delete draft["mcpServers"];
        },
      });
      continue;
    }

    if (mode === "uninstall") {
      // A file the user has changed since install is theirs now: deleting it
      // would throw away their work. It stays, and the screen says so.
      if (userEditedKitFile(kit, entry.from, absolutePath)) {
        files.kept.push(absolutePath);
        continue;
      }
      ops.push({ kind: "deleteFile", filePath: absolutePath });
      continue;
    }

    const executable =
      (entry.kind === "hook" || entry.kind === "script") && entry.executable !== false;
    ops.push({
      kind: "createFile",
      filePath: absolutePath,
      contents: readKitFile(kit, entry.from),
      mode: executable ? EXECUTABLE_MODE : DEFAULT_CONTENT_MODE,
      // An older copy ccpanel wrote is replaced; anything else is a conflict.
      overwrite: isOlderKitCopy(kit, entry.from, absolutePath),
    });
  }

  return ops;
}

/**
 * Merges (or removes) a kit's settings patch. Only the entries the kit owns
 * are touched — a user's own hooks on the same event stay put.
 */
function applySettingsPatch(
  draft: Record<string, unknown>,
  patch: Record<string, unknown>,
  mode: "install" | "uninstall",
  permissionValues: { added: PermissionLists; remove: PermissionLists | undefined } = {
    added: {},
    remove: undefined,
  },
  olderCommands: string[] = [],
): void {
  for (const [topKey, topValue] of Object.entries(patch)) {
    if (topKey === "hooks" && typeof topValue === "object" && topValue !== null) {
      const existingHooks = (draft["hooks"] as Record<string, unknown>) ?? {};
      const nextHooks: Record<string, unknown> = { ...existingHooks };

      for (const [eventName, eventEntries] of Object.entries(topValue as Record<string, unknown>)) {
        if (!Array.isArray(eventEntries)) continue;
        const current = Array.isArray(nextHooks[eventName])
          ? [...(nextHooks[eventName] as unknown[])]
          : [];

        for (const ourEntry of eventEntries) {
          const command = extractCommand(ourEntry);
          const withoutOurs = command
            ? withoutOurCommands(current, new Set([command, ...olderCommands]), matcherOf(ourEntry))
            : current;
          current.length = 0;
          current.push(...withoutOurs);
          if (mode === "install") current.push(ourEntry);
        }

        if (current.length > 0) nextHooks[eventName] = current;
        else delete nextHooks[eventName];
      }

      if (Object.keys(nextHooks).length > 0) draft["hooks"] = nextHooks;
      else delete draft["hooks"];
      continue;
    }

    if (topKey === "permissions" && typeof topValue === "object" && topValue !== null) {
      const existing = (draft["permissions"] as Record<string, unknown>) ?? {};
      const next: Record<string, unknown> = { ...existing };
      for (const [listName, values] of Object.entries(topValue as Record<string, unknown>)) {
        if (!Array.isArray(values)) continue;
        const current = Array.isArray(next[listName]) ? (next[listName] as string[]) : [];
        if (mode === "install") {
          permissionValues.added[listName] = (values as string[]).filter(
            (v) => !current.includes(v),
          );
          next[listName] = Array.from(new Set([...current, ...(values as string[])]));
        } else {
          // Without a plan (an install from before ccpanel kept records),
          // fall back to the kit's whole list.
          const remove = permissionValues.remove
            ? (permissionValues.remove[listName] ?? [])
            : (values as string[]);
          next[listName] = current.filter((v) => !remove.includes(v));
        }
        if ((next[listName] as string[]).length === 0) delete next[listName];
      }
      if (Object.keys(next).length > 0) draft["permissions"] = next;
      else delete draft["permissions"];
      continue;
    }

    if (mode === "install") draft[topKey] = topValue;
    else delete draft[topKey];
  }
}

/**
 * Takes the kit's own command objects out of a list of hook groups.
 *
 * A group is `{ matcher, hooks: [...] }`, and the user may have added their
 * own command to the same group as ours. Dropping the whole group would
 * delete theirs too, so only our command objects go; a group is dropped
 * only once nothing is left in it.
 */
function withoutOurCommands(groups: unknown[], commands: Set<string>, matcher?: string): unknown[] {
  const out: unknown[] = [];
  for (const group of groups) {
    const hooks =
      typeof group === "object" && group !== null
        ? (group as { hooks?: unknown }).hooks
        : undefined;
    const sameMatcher = matcher === undefined || matcherOf(group) === matcher;
    if (!Array.isArray(hooks) || !sameMatcher) {
      out.push(group);
      continue;
    }
    const kept = hooks.filter((h) => {
      const c =
        typeof h === "object" && h !== null ? (h as { command?: unknown }).command : undefined;
      return !(typeof c === "string" && commands.has(c));
    });
    if (kept.length === hooks.length) out.push(group);
    else if (kept.length > 0) out.push({ ...(group as Record<string, unknown>), hooks: kept });
  }
  return out;
}

function extractCommands(entry: unknown): string[] {
  if (typeof entry !== "object" || entry === null) return [];
  const hooks = (entry as { hooks?: unknown }).hooks;
  if (!Array.isArray(hooks)) return [];
  return hooks
    .map((h) => (typeof h === "object" && h !== null ? (h as { command?: unknown }).command : null))
    .filter((c): c is string => typeof c === "string");
}

function extractCommand(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null) return null;
  const hooks = (entry as { hooks?: unknown }).hooks;
  if (!Array.isArray(hooks)) return null;
  for (const h of hooks) {
    if (typeof h === "object" && h !== null) {
      const c = (h as { command?: unknown }).command;
      if (typeof c === "string") return c;
    }
  }
  return null;
}

/**
 * True when the file at `target` is no longer what ccpanel put there: it
 * matches neither what the kit ships now nor what ccpanel recorded writing
 * (an older version of the kit, which an update may replace).
 */
function userEditedKitFile(kit: Kit, from: string, target: string): boolean {
  let current: string;
  try {
    current = fs.readFileSync(target, "utf8");
  } catch {
    return false; // already gone: nothing to protect
  }
  if (isRecordedKitFile(target, current)) return false;
  try {
    return current !== readKitFile(kit, from);
  } catch {
    return true; // can't compare against the original, so don't risk it
  }
}

// ---------------------------------------------------------------------------
// Which kit files ccpanel wrote
//
// Comparing a file on disk with what the kit ships now can't tell an older
// version of the kit from a file the user edited, so updating a kit used to
// be impossible: the old copy was "edited", kept on uninstall and a conflict
// on install. Install now records a hash of each file it writes; a file
// that still has that hash is the kit's own, to replace or remove.
// ---------------------------------------------------------------------------

/** Installed file path → sha256 of the contents ccpanel wrote there. */
type FileLedger = Record<string, string>;

export function fileLedgerPath(): string {
  return path.join(ccpanelHome(), "kit-files.json");
}

function readFileLedger(): FileLedger {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(fileLedgerPath(), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as FileLedger)
      : {};
  } catch {
    return {};
  }
}

function writeFileLedger(ledger: FileLedger): void {
  atomicWriteFile(fileLedgerPath(), serializeJson(ledger));
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** True when `contents` is exactly what ccpanel last recorded writing at `target`. */
function isRecordedKitFile(target: string, contents: string): boolean {
  return readFileLedger()[target] === sha256(contents);
}

/** What sits at `target` now, when it is an earlier copy ccpanel wrote of a kit file. */
function isOlderKitCopy(kit: Kit, from: string, target: string): boolean {
  try {
    const current = fs.readFileSync(target, "utf8");
    return current !== readKitFile(kit, from) && isRecordedKitFile(target, current);
  } catch {
    return false;
  }
}

/** File entries of a kit: everything that isn't a settings, CLAUDE.md or tool change. */
function fileEntriesOf(kit: Kit) {
  return kit.installs.filter(
    (e): e is Extract<InstallEntry, { from: string }> =>
      e.kind !== "settings" && e.kind !== "claudemd" && e.kind !== "mcp",
  );
}

/**
 * True when the kit is installed but at least one of its files is an older
 * copy ccpanel wrote, so setting it up again would bring it up to date.
 */
export function kitHasUpdate(kit: Kit, repo: RepoInfo): boolean {
  const olderFile = fileEntriesOf(kit).some((entry) =>
    isOlderKitCopy(kit, entry.from, targetPathFor(kit, entry, repo)),
  );
  return olderFile || hasOlderHookCommand(kit, repo);
}

/** Every hook command string in a settings file, whatever the event or group. */
function hookCommandsIn(filePath: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
  const hooks =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { hooks?: unknown }).hooks
      : undefined;
  if (typeof hooks !== "object" || hooks === null) return [];
  const commands: string[] = [];
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const c = extractCommands(group);
      commands.push(...c);
    }
  }
  return commands;
}

/** True when settings still run a hook the way an earlier version of the kit wrote it. */
function hasOlderHookCommand(kit: Kit, repo: RepoInfo): boolean {
  return kit.installs.some((entry) => {
    if (entry.kind !== "settings" || !entry.replacesCommands?.length) return false;
    const older = new Set(entry.replacesCommands);
    return hookCommandsIn(targetPathFor(kit, entry, repo)).some((c) => older.has(c));
  });
}

// ---------------------------------------------------------------------------
// Which permission values a kit actually added
//
// "Every kit uninstalls exactly what it added" (README). For a permission
// list that means: not a value the user already had before the kit came
// along, and not one another installed kit still declares. So install notes
// which values were new, and uninstall removes only those.
// ---------------------------------------------------------------------------

type PermissionLists = Record<string, string[]>;
/** settings file → kit id → the values that kit added, per list. */
type PermissionLedger = Record<string, Record<string, PermissionLists>>;

export function permissionLedgerPath(): string {
  return path.join(ccpanelHome(), "kit-permissions.json");
}

function readPermissionLedger(): PermissionLedger {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(permissionLedgerPath(), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as PermissionLedger)
      : {};
  } catch {
    return {}; // missing or broken: behave as if nothing was recorded
  }
}

function writePermissionLedger(ledger: PermissionLedger): void {
  atomicWriteFile(permissionLedgerPath(), serializeJson(ledger));
}

function permissionPatchOf(entry: InstallEntry): PermissionLists | null {
  if (entry.kind !== "settings") return null;
  const perms = entry.patch["permissions"];
  if (typeof perms !== "object" || perms === null) return null;
  const out: PermissionLists = {};
  for (const [list, values] of Object.entries(perms as Record<string, unknown>)) {
    if (Array.isArray(values)) out[list] = values.filter((v): v is string => typeof v === "string");
  }
  return out;
}

function mergeLists(into: PermissionLists, from: PermissionLists): PermissionLists {
  const out: PermissionLists = { ...into };
  for (const [list, values] of Object.entries(from)) {
    out[list] = Array.from(new Set([...(out[list] ?? []), ...values]));
  }
  return out;
}

/**
 * Other kits that count as installed for one settings file: ones ccpanel has
 * a record of installing there, plus kits whose files are on disk. A
 * settings-only kit with no record can't be told apart from "the values just
 * happen to be there", so it doesn't count.
 */
function otherInstalledKits(kit: Kit, repo: RepoInfo, file: string, ledger: PermissionLedger) {
  const out: Array<{ kit: Kit; lists: PermissionLists }> = [];
  for (const other of loadKits(path.dirname(kit.dir))) {
    if (other.id === kit.id) continue;
    for (const entry of other.installs) {
      const lists = permissionPatchOf(entry);
      if (!lists || targetPathFor(other, entry, repo) !== file) continue;
      const hasFiles = other.installs.some(
        (e) => e.kind !== "settings" && e.kind !== "claudemd" && e.kind !== "mcp",
      );
      const recorded = ledger[file]?.[other.id] !== undefined;
      if (recorded || (hasFiles && isKitInstalled(other, repo))) out.push({ kit: other, lists });
    }
  }
  return out;
}

/**
 * Works out, per settings file, which values uninstalling `kit` should take
 * out, and which values should pass to another installed kit that also
 * declares them (so the last kit to go still removes them).
 */
function planPermissionRemoval(kit: Kit, repo: RepoInfo, ledger: PermissionLedger) {
  const remove = new Map<string, PermissionLists>();
  const handOver: Array<{ file: string; kitId: string; lists: PermissionLists }> = [];

  for (const entry of kit.installs) {
    const declared = permissionPatchOf(entry);
    if (!declared) continue;
    const file = targetPathFor(kit, entry, repo);
    // No record means an install from before records were kept: the best we
    // can do is the kit's own list, still minus what other kits need.
    const ours = ledger[file]?.[kit.id] ?? declared;
    const others = otherInstalledKits(kit, repo, file, ledger);

    const lists: PermissionLists = {};
    for (const [list, values] of Object.entries(ours)) {
      lists[list] = values.filter((value) => {
        const keeper = others.find((o) => o.lists[list]?.includes(value));
        if (!keeper) return true;
        handOver.push({ file, kitId: keeper.kit.id, lists: { [list]: [value] } });
        return false;
      });
    }
    remove.set(file, lists);
  }
  return { remove, handOver };
}

export function installKit(
  kit: Kit,
  repo: RepoInfo,
  recordUndo?: (
    meta: { kind: string; id: string; label: string },
    changes: RecordedChange[],
  ) => void,
): TransactionResult {
  const permissions: PermissionPlan = { added: new Map(), remove: new Map() };
  const mcp: McpPlan = { ledger: readMcpLedger(), written: [] };
  const result = runTransaction(
    buildOperations(kit, repo, "install", permissions, { kept: [] }, mcp),
    {
      kind: "kit",
      id: kit.id,
      label: `Set up: ${kit.title}`,
    },
    recordUndo,
  );
  if (result.ok && permissions.added.size > 0) {
    const ledger = readPermissionLedger();
    for (const [file, added] of permissions.added) {
      const byKit = ledger[file] ?? {};
      // Merged, not replaced: installing twice finds the values already
      // there, and must not forget that this kit was the one that added them.
      byKit[kit.id] = mergeLists(byKit[kit.id] ?? {}, added);
      ledger[file] = byKit;
    }
    writePermissionLedger(ledger);
  }
  if (result.ok) {
    const ledger = readFileLedger();
    let changed = false;
    for (const entry of fileEntriesOf(kit)) {
      try {
        ledger[targetPathFor(kit, entry, repo)] = sha256(readKitFile(kit, entry.from));
        changed = true;
      } catch {
        /* a missing kit file failed the install already */
      }
    }
    if (changed) writeFileLedger(ledger);
  }
  if (result.ok && mcp.written.length > 0) {
    const ledger = readMcpLedger();
    for (const { file, name } of mcp.written) {
      const entry = kit.installs.find((e) => e.kind === "mcp" && e.name === name);
      if (entry?.kind === "mcp") ledger[file] = { ...(ledger[file] ?? {}), [name]: entry.server };
    }
    writeMcpLedger(ledger);
  }
  return result;
}

export interface UninstallResult extends TransactionResult {
  /** Kit files left in place because the user had edited them. */
  keptFiles: string[];
}

export function uninstallKit(
  kit: Kit,
  repo: RepoInfo,
  recordUndo?: (
    meta: { kind: string; id: string; label: string },
    changes: RecordedChange[],
  ) => void,
): UninstallResult {
  const ledger = readPermissionLedger();
  const { remove, handOver } = planPermissionRemoval(kit, repo, ledger);
  const files: FilePlan = { kept: [] };
  const mcpLedger = readMcpLedger();
  const result = runTransaction(
    buildOperations(kit, repo, "uninstall", { added: new Map(), remove }, files, {
      ledger: mcpLedger,
      written: [],
    }),
    {
      kind: "kit-uninstall",
      id: kit.id,
      label: `Removed: ${kit.title}`,
    },
    recordUndo,
  );
  if (result.ok && remove.size > 0) {
    for (const file of remove.keys()) {
      if (ledger[file]) delete ledger[file][kit.id];
    }
    for (const { file, kitId, lists } of handOver) {
      const byKit = ledger[file] ?? {};
      byKit[kitId] = mergeLists(byKit[kitId] ?? {}, lists);
      ledger[file] = byKit;
    }
    writePermissionLedger(ledger);
  }
  if (result.ok) {
    const ledger = readFileLedger();
    let changed = false;
    for (const entry of fileEntriesOf(kit)) {
      const file = targetPathFor(kit, entry, repo);
      if (files.kept.includes(file) || ledger[file] === undefined) continue;
      delete ledger[file];
      changed = true;
    }
    if (changed) writeFileLedger(ledger);
  }
  if (result.ok) {
    let changed = false;
    for (const entry of kit.installs) {
      if (entry.kind !== "mcp") continue;
      const file = targetPathFor(kit, entry, repo);
      if (mcpLedger[file]?.[entry.name] === undefined) continue;
      // Forgotten once removed; kept in the record if the entry stayed
      // because the user had changed it, which they now own anyway.
      delete mcpLedger[file][entry.name];
      if (Object.keys(mcpLedger[file]).length === 0) delete mcpLedger[file];
      changed = true;
    }
    if (changed) writeMcpLedger(mcpLedger);
  }
  return { ...result, keptFiles: result.ok ? files.kept : [] };
}

export interface UninstallPreviewLine {
  action: "delete" | "change" | "keep";
  displayPath: string;
  note: string;
  details?: string[];
}

/**
 * What "Remove it" would do, worked out the same way uninstallKit decides:
 * shown before anything is touched, so removing is never one keypress.
 */
export function previewUninstall(kit: Kit, repo: RepoInfo): UninstallPreviewLine[] {
  const lines: UninstallPreviewLine[] = [];
  const { remove } = planPermissionRemoval(kit, repo, readPermissionLedger());
  const mcpLedger = readMcpLedger();

  for (const entry of kit.installs) {
    const absolutePath = targetPathFor(kit, entry, repo);
    const displayPath = path.relative(repo.projectDir, absolutePath) || absolutePath;

    if (entry.kind === "settings") {
      const details: string[] = [];
      for (const [list, values] of Object.entries(remove.get(absolutePath) ?? {})) {
        if (values.length > 0)
          details.push(`${PERMISSION_LIST_LABELS[list] ?? list}: ${values.join(", ")}`);
      }
      const hooks = entry.patch["hooks"];
      if (hooks !== undefined) details.push(...settingsPatchDetails({ hooks }));
      if (details.length === 0) continue;
      lines.push({
        action: "change",
        displayPath,
        note: "takes out only what this kit added",
        details,
      });
      continue;
    }

    if (entry.kind === "claudemd") {
      let present = false;
      try {
        present = findFencedBlock(fs.readFileSync(absolutePath, "utf8"), entry.blockId) !== null;
      } catch {
        present = false;
      }
      if (present) {
        lines.push({ action: "change", displayPath, note: "removes the section this kit added" });
      }
      continue;
    }

    if (entry.kind === "mcp") {
      if (entry.scope === "user") continue;
      const current = readMcpServer(absolutePath, entry.name);
      if (current === undefined) continue;
      const recorded = mcpLedger[absolutePath]?.[entry.name];
      lines.push(
        recorded !== undefined && isKitsOwnServer(entry, current, recorded)
          ? { action: "change", displayPath, note: `removes the "${entry.name}" tool entry` }
          : {
              action: "keep",
              displayPath,
              note: `keeps the "${entry.name}" tool entry: ccpanel didn't write it as it is now`,
            },
      );
      continue;
    }

    if (!fs.existsSync(absolutePath)) continue;
    lines.push(
      userEditedKitFile(kit, entry.from, absolutePath)
        ? { action: "keep", displayPath, note: "you've changed it, so it stays" }
        : { action: "delete", displayPath, note: "deletes this file" },
    );
  }
  return lines;
}

/** True when every file the kit installs is present (§9.3, acceptance #11). */
export function isKitInstalled(kit: Kit, repo: RepoInfo): boolean {
  const fileEntries = kit.installs.filter(
    (e) => e.kind !== "settings" && e.kind !== "claudemd" && e.kind !== "mcp",
  );

  if (fileEntries.length > 0) {
    return fileEntries.every((entry) => fs.existsSync(targetPathFor(kit, entry, repo)));
  }

  // Kits that only patch settings leave no files at all, so detection has to
  // look for the values themselves — otherwise installing twice would silently
  // duplicate them (acceptance #11).
  const mcpEntries = kit.installs.filter((e) => e.kind === "mcp");
  if (mcpEntries.length === 0) {
    const settingsEntries = kit.installs.filter((e) => e.kind === "settings");
    if (settingsEntries.length === 0) return false;
    return settingsEntries.every((entry) =>
      settingsPatchApplied(targetPathFor(kit, entry, repo), entry.patch),
    );
  }
  return mcpEntries.every((entry) => {
    if (entry.scope === "user") return false;
    // Only this kit's own entry counts. A user's own tool that happens to
    // share the name is not this kit being installed.
    const current = readMcpServer(targetPathFor(kit, entry, repo), entry.name);
    return current !== undefined && sameJson(current, entry.server);
  });
}

// ---------------------------------------------------------------------------
// Post-install self-check (§9.5)
// ---------------------------------------------------------------------------

export interface CheckItem {
  ok: boolean;
  label: string;
  detail: string | null;
}

export interface VerifyResult {
  ok: boolean;
  checks: CheckItem[];
}

function anySettingsHasDisableAllHooks(repo: RepoInfo): boolean {
  const paths = getClaudePaths(repo);
  for (const file of [paths.userSettings, paths.projectSettings, paths.localSettings]) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as Record<string, unknown>)["disableAllHooks"] === true
      ) {
        return true;
      }
    } catch {}
  }
  return false;
}

function hasJsonParser(): boolean {
  for (const bin of ["jq", "node", "python3"]) {
    try {
      execFileSync("command", ["-v", bin], { stdio: "ignore", shell: "/bin/bash", timeout: 1000 });
      return true;
    } catch {}
  }
  return false;
}

/**
 * The self-check to run straight after installing `kit`, or null when the kit
 * has none. Only the deletion warning has one: it fires a pretend `rm -rf /`
 * through its hook, and running that test against any other kit would show
 * a page of red crosses for a check that kit was never meant to pass.
 */
export function postInstallCheck(kit: Kit, repo: RepoInfo): VerifyResult | null {
  return kit.id === "deletion-warning" ? verifyDeletionWarning(kit, repo) : null;
}

/**
 * The hook command this kit has in settings now: today's, or one an earlier
 * version wrote. Falls back to today's when settings can't be read.
 */
function installedHookCommand(kit: Kit, repo: RepoInfo): string {
  const entry = kit.installs.find((e) => e.kind === "settings");
  if (entry?.kind !== "settings") return "";
  const current = Object.values((entry.patch["hooks"] as Record<string, unknown>) ?? {}).flatMap(
    (groups) => (Array.isArray(groups) ? groups.flatMap(extractCommands) : []),
  );
  const ours = new Set([...current, ...(entry.replacesCommands ?? [])]);
  const stored = hookCommandsIn(targetPathFor(kit, entry, repo)).find((c) => ours.has(c));
  return stored ?? current[0] ?? "";
}

/** The line shown once a kit is set up. Kit-specific wording only where it is true. */
export function installedMessage(kit: Kit): string {
  if (kit.id === "deletion-warning") {
    return "Done. Claude will check with you before big deletions now.";
  }
  return `Done. ${kit.title} is set up.`;
}

/**
 * Fires a synthetic destructive call through the installed hook and confirms
 * it asks. Without this, a hook that silently does nothing looks identical to
 * one that works — the worst outcome for a safety feature.
 */
export function verifyDeletionWarning(kit: Kit, repo: RepoInfo): VerifyResult {
  const checks: CheckItem[] = [];
  const hookEntry = kit.installs.find((e) => e.kind === "hook");
  const scriptPath = hookEntry ? targetPathFor(kit, hookEntry, repo) : null;

  const exists = scriptPath !== null && fs.existsSync(scriptPath);
  checks.push({
    ok: exists,
    label: "The file is in place",
    detail: exists ? null : "The safety check couldn't be found where it was installed.",
  });

  const executable = exists && isExecutable(scriptPath as string);
  checks.push({
    ok: executable,
    label: "It's allowed to run",
    detail: executable ? null : "The file isn't set as runnable, so it would never start.",
  });

  const parser = hasJsonParser();
  checks.push({
    ok: parser,
    label: "Your computer can read the checks",
    detail: parser
      ? null
      : "This needs jq, node or python3 installed. Without one, it stays silent.",
  });

  const hooksOff = anySettingsHasDisableAllHooks(repo);
  checks.push({
    ok: !hooksOff,
    label: "Automatic checks are switched on",
    detail: hooksOff
      ? "Something in your setup turns off all automatic checks, so this can't run."
      : null,
  });

  let fired = false;
  let fireDetail: string | null = "Couldn't try a test run.";
  if (executable && parser) {
    try {
      // Run the command exactly as it sits in settings, through a shell, the
      // way Claude Code runs it. Running the script file directly would pass
      // even when the command itself can't find it (a folder name with a
      // space in it, with the variable left unquoted).
      const out = execFileSync("/bin/sh", ["-c", installedHookCommand(kit, repo)], {
        input: JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: "rm -rf /" },
        }),
        cwd: repo.projectDir,
        env: { ...process.env, CLAUDE_PROJECT_DIR: repo.projectDir },
        encoding: "utf8",
        timeout: 3000,
      });
      fired = out.includes('"permissionDecision"') && out.includes('"ask"');
      fireDetail = fired ? null : "The test run didn't produce a warning.";
    } catch (err) {
      fireDetail = err instanceof Error ? err.message : String(err);
    }
  }
  checks.push({ ok: fired, label: "A test warning worked", detail: fireDetail });

  return { ok: checks.every((c) => c.ok), checks };
}
