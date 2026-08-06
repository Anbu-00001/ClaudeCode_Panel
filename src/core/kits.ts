import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { RungId } from "./detect.js";
import { type ClaudePaths, type RepoInfo, getClaudePaths } from "./paths.js";
import {
  DEFAULT_CONTENT_MODE,
  EXECUTABLE_MODE,
  type Operation,
  type RecordedChange,
  type TransactionResult,
  isExecutable,
  runTransaction,
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
  }),
  z.looseObject({
    kind: z.literal("settings"),
    scope: z.enum(["project", "local", "user"]),
    patch: z.record(z.string(), z.unknown()),
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

export function targetPathFor(kit: Kit, entry: InstallEntry, repo: RepoInfo): string {
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
          if (command && !(have as unknown[]).some((e) => isOurHookEntry(e, command, matcher))) return false;
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
}

export interface KitPreview {
  kit: Kit;
  lines: PreviewLine[];
  conflicts: PreviewLine[];
  /** Full contents of each file, for "Show me the files". */
  files: Array<{ displayPath: string; contents: string }>;
  warnings: string[];
}

function readKitFile(kit: Kit, from: string): string {
  return fs.readFileSync(path.join(kit.dir, from), "utf8");
}

export function previewKit(kit: Kit, repo: RepoInfo): KitPreview {
  const lines: PreviewLine[] = [];
  const files: Array<{ displayPath: string; contents: string }> = [];
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
      });
      continue;
    }

    if (entry.kind === "claudemd") {
      lines.push({
        op: "append",
        displayPath,
        absolutePath,
        note: "adds a section, leaving everything already there alone",
        conflict: false,
      });
      files.push({ displayPath, contents: entry.content });
      continue;
    }

    if (entry.kind === "mcp") {
      lines.push({
        op: fs.existsSync(absolutePath) ? "change" : "create",
        displayPath,
        absolutePath,
        note: "tells Claude how to start this tool when it needs it",
        conflict: false,
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

    let conflict = false;
    try {
      if (fs.existsSync(absolutePath) && fs.readFileSync(absolutePath, "utf8") !== contents) {
        conflict = true;
      }
    } catch {
      conflict = false;
    }

    lines.push({
      op: "create",
      displayPath,
      absolutePath,
      note: entry.kind === "hook" ? "runs automatically before Claude uses a tool" : null,
      conflict,
    });
    files.push({ displayPath, contents });
  }

  return { kit, lines, conflicts: lines.filter((l) => l.conflict), files, warnings };
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

function buildOperations(kit: Kit, repo: RepoInfo, mode: "install" | "uninstall"): Operation[] {
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
          applySettingsPatch(draft, patch, mode);
        },
      });
      continue;
    }

    if (entry.kind === "claudemd") {
      ops.push(
        mode === "install"
          ? { kind: "appendBlock", filePath: absolutePath, blockId: entry.blockId, content: entry.content }
          : { kind: "removeBlock", filePath: absolutePath, blockId: entry.blockId },
      );
      continue;
    }

    if (entry.kind === "mcp") {
      // User scope would mean writing ~/.claude.json, which holds the OAuth
      // session and is known to corrupt under concurrent writes. Skipped here
      // and surfaced as a copyable `claude mcp add` command instead.
      if (entry.scope === "user") continue;
      ops.push({
        kind: "patchJson",
        filePath: absolutePath,
        keyPath: ["mcpServers", entry.name],
        mutate: (draft) => {
          const servers = (draft["mcpServers"] as Record<string, unknown>) ?? {};
          const next = { ...servers };
          if (mode === "install") next[entry.name] = entry.server;
          else delete next[entry.name];
          if (Object.keys(next).length > 0) draft["mcpServers"] = next;
          else delete draft["mcpServers"];
        },
      });
      continue;
    }

    if (mode === "uninstall") {
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
): void {
  for (const [topKey, topValue] of Object.entries(patch)) {
    if (topKey === "hooks" && typeof topValue === "object" && topValue !== null) {
      const existingHooks = (draft["hooks"] as Record<string, unknown>) ?? {};
      const nextHooks: Record<string, unknown> = { ...existingHooks };

      for (const [eventName, eventEntries] of Object.entries(topValue as Record<string, unknown>)) {
        if (!Array.isArray(eventEntries)) continue;
        const current = Array.isArray(nextHooks[eventName]) ? [...(nextHooks[eventName] as unknown[])] : [];

        for (const ourEntry of eventEntries) {
          const command = extractCommand(ourEntry);
          const matcher = matcherOf(ourEntry);
          const withoutOurs = current.filter((e) => !(command && isOurHookEntry(e, command, matcher)));
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
        next[listName] =
          mode === "install"
            ? Array.from(new Set([...current, ...(values as string[])]))
            : current.filter((v) => !(values as string[]).includes(v));
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

export function installKit(
  kit: Kit,
  repo: RepoInfo,
  recordUndo?: (meta: { kind: string; id: string; label: string }, changes: RecordedChange[]) => void,
): TransactionResult {
  return runTransaction(buildOperations(kit, repo, "install"), {
    kind: "kit",
    id: kit.id,
    label: `Set up: ${kit.title}`,
  }, recordUndo);
}

export function uninstallKit(
  kit: Kit,
  repo: RepoInfo,
  recordUndo?: (meta: { kind: string; id: string; label: string }, changes: RecordedChange[]) => void,
): TransactionResult {
  return runTransaction(buildOperations(kit, repo, "uninstall"), {
    kind: "kit-uninstall",
    id: kit.id,
    label: `Removed: ${kit.title}`,
  }, recordUndo);
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
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(targetPathFor(kit, entry, repo), "utf8"));
      const servers = (parsed as { mcpServers?: Record<string, unknown> })?.mcpServers;
      return Boolean(servers && entry.name in servers);
    } catch {
      return false;
    }
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
      if (typeof parsed === "object" && parsed !== null && (parsed as Record<string, unknown>)["disableAllHooks"] === true) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

function hasJsonParser(): boolean {
  for (const bin of ["jq", "node", "python3"]) {
    try {
      execFileSync("command", ["-v", bin], { stdio: "ignore", shell: "/bin/bash", timeout: 1000 });
      return true;
    } catch {
      continue;
    }
  }
  return false;
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
    detail: parser ? null : "This needs jq, node or python3 installed. Without one, it stays silent.",
  });

  const hooksOff = anySettingsHasDisableAllHooks(repo);
  checks.push({
    ok: !hooksOff,
    label: "Automatic checks are switched on",
    detail: hooksOff ? "Something in your setup turns off all automatic checks, so this can't run." : null,
  });

  let fired = false;
  let fireDetail: string | null = "Couldn't try a test run.";
  if (executable && parser) {
    try {
      const out = execFileSync(scriptPath as string, {
        input: JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: "rm -rf /" },
        }),
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
