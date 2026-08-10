import { execFile } from "node:child_process";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { SkillInfo } from "./skills.js";

/**
 * Working out whether a skill is out of date, and how it could be updated
 * (§5.1, §5.3, §10.5).
 *
 * ccpanel lists skills but has never been able to say whether one is stale, so
 * a personal skill in ~/.claude/skills sits at whatever version it was on the
 * day it was copied there. Nothing in Claude Code's own files records where a
 * personal skill came from, so this module works it out from evidence on disk
 * instead: an installed-plugin record, a git clone, or a version-marker file
 * next to a matching command on PATH.
 *
 * Three rules shape everything below.
 *
 * C1 — no Anthropic API, no money, and (with one exception) no network at all.
 * Everything here is arithmetic over local files plus read-only `git`/`--version`
 * calls against binaries already installed. `fetchGitRemote` is the single
 * network call in the module and it only ever runs when the user asks for it.
 *
 * UNKNOWN is a first-class answer. Most marketplace catalogue entries carry no
 * version at all, and local git refs go stale the moment someone pushes. Where
 * the files cannot answer the question we say so; we never round "can't tell"
 * up to "up to date", because a wrong reassurance is worse than a shrug.
 *
 * Nothing is hardcoded. No tool name, version, path or marketplace name is
 * baked in — the marker filename names the command, the command names its own
 * version, and a command is only ever suggested after its own `--help` has
 * been read at runtime and found to list it.
 */

// ---------------------------------------------------------------------------
// Running other programs
// ---------------------------------------------------------------------------

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
}

export interface ExecResult {
  ok: boolean;
  /** Process exit code, or null when it never got that far. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Why it failed. "missing" is normal — the tool simply isn't installed. */
  failure: "missing" | "timeout" | "error" | null;
}

/**
 * Every child process goes through this shape: an argv array, never a string
 * handed to a shell, so a skill directory named `; rm -rf ~` is just a
 * directory name. Injectable so tests can answer without running anything.
 */
export type ExecRunner = (
  file: string,
  args: readonly string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

/** Long enough for a cold `--version`, short enough not to hang the screen. */
const DEFAULT_TIMEOUT_MS = 4_000;
/** A fetch talks to a server, so it gets a longer leash than a local call. */
const FETCH_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export const defaultExec: ExecRunner = (file, args, options = {}) =>
  new Promise<ExecResult>((resolve) => {
    execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, code: 0, stdout, stderr, failure: null });
          return;
        }
        const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
        // A command that isn't installed is an ordinary answer here, not a
        // crash — plenty of skills reference a tool the user never installed.
        const failure: ExecResult["failure"] =
          err.code === "ENOENT" ? "missing" : err.killed === true || err.signal ? "timeout" : "error";
        resolve({
          ok: false,
          code: typeof err.code === "number" ? err.code : null,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          failure,
        });
      },
    );
  });

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** 1 to 4 numeric parts. Anything else is not a version we can reason about. */
const CORE_PATTERN = /^\d+(?:\.\d+){0,3}$/;
/** A version-looking run inside arbitrary output: `sometool 1.2.3`, `v2.0.0-rc.1`. */
const VERSION_IN_TEXT = /(?:^|[^\w.-])v?(\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)(?![\w.-])/;

interface ParsedVersion {
  core: number[];
  prerelease: string[];
}

function parseVersionParts(raw: string): ParsedVersion | null {
  let text = raw.trim();
  if (text === "") return null;
  text = text.replace(/^[vV]/, "");

  // Build metadata (`1.0.0+build.7`) is explicitly ignored when comparing.
  const plus = text.indexOf("+");
  if (plus !== -1) text = text.slice(0, plus);

  const dash = text.indexOf("-");
  const core = dash === -1 ? text : text.slice(0, dash);
  const pre = dash === -1 ? "" : text.slice(dash + 1);
  if (!CORE_PATTERN.test(core)) return null;
  if (dash !== -1 && pre.trim() === "") return null; // `1.0.0-` is junk, not a release

  const numbers = core.split(".").map((part) => Number(part));
  if (numbers.some((n) => !Number.isSafeInteger(n))) return null;

  const identifiers = pre === "" ? [] : pre.split(".");
  if (identifiers.some((id) => id === "")) return null;

  return { core: numbers, prerelease: identifiers };
}

/** True when this string is something we can actually order against another. */
export function isComparableVersion(raw: string): boolean {
  return parseVersionParts(raw) !== null;
}

function comparePrerelease(a: string[], b: string[]): -1 | 0 | 1 {
  // A release outranks any prerelease of the same numbers: 1.0.0 > 1.0.0-rc.1.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) return -1; // fewer identifiers sorts first
    if (right === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      const l = Number(left);
      const r = Number(right);
      if (l !== r) return l < r ? -1 : 1;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1; // numbers rank below words
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Orders two versions the way semver does, without taking on a dependency for
 * it. Returns null when either side isn't a version at all — a branch name, a
 * commit hash, "latest" — which becomes an UNKNOWN status rather than a guess.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const left = parseVersionParts(a);
  const right = parseVersionParts(b);
  if (!left || !right) return null;

  const length = Math.max(left.core.length, right.core.length);
  for (let i = 0; i < length; i++) {
    // Missing trailing parts are zero, so 1.0 and 1.0.0 are the same release.
    const l = left.core[i] ?? 0;
    const r = right.core[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/**
 * Pulls a version out of whatever a command prints for `--version`, which is
 * anything from `1.2.3` to `mytool version 1.2.3 (build abc)`.
 */
export function extractVersion(text: string): string | null {
  const lines = text.split("\n").slice(0, 10);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (parseVersionParts(trimmed)) return trimmed.replace(/^[vV]/, "");
    const match = VERSION_IN_TEXT.exec(trimmed);
    if (match?.[1]) return match[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Finding a command without running one
// ---------------------------------------------------------------------------

/** Command names we are willing to look for: no slashes, no `..`, no tricks. */
const SAFE_COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Walks PATH itself instead of shelling out to `which`. The name comes from a
 * file inside a skill directory, so it is checked against a strict pattern
 * before being joined onto anything.
 */
export function findOnPath(
  command: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (!SAFE_COMMAND_NAME.test(command) || command.includes("..")) return null;
  const raw = env["PATH"] ?? "";
  for (const dir of raw.split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, command);
    try {
      if (!fs.statSync(candidate).isFile()) continue; // statSync follows the usual symlink shims
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not in this directory
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The result shape
// ---------------------------------------------------------------------------

export type UpdateStatus = "up-to-date" | "behind" | "unknown";

/** How a skill's freshness was worked out, in the order they are tried. */
export type UpdateMethod = "plugin" | "git" | "tool" | "manual";

export interface UpdateCommand {
  /** argv, never a shell line — the UI should spawn this as-is. */
  argv: string[];
  /** The same thing as one readable line, for the preview C5 requires. */
  display: string;
  /** Claude Code has to be restarted (or /reload-plugins run) to see it (§5.3). */
  needsRestart: boolean;
}

interface UpdateCheckCommon {
  skill: SkillInfo;
  /** The skill's own directory — where SKILL.md lives. */
  dir: string;
  status: UpdateStatus;
  /** One short line for a list row. */
  summary: string;
  /** A sentence or two saying how we know, for the detail pane. */
  detail: string;
  /** null when there is no update path we can honestly offer. */
  command: UpdateCommand | null;
}

export interface PluginUpdateCheck extends UpdateCheckCommon {
  method: "plugin";
  /** `name@marketplace`, as Claude Code writes it. */
  pluginId: string;
  pluginName: string;
  marketplace: string;
  installedVersion: string | null;
  /** From the marketplace catalogue on disk. Usually absent — most entries have none. */
  catalogVersion: string | null;
  /** The catalogue's git ref/tag, shown for information only; never used to judge staleness. */
  catalogRef: string | null;
  installPath: string | null;
  /** ISO timestamp Claude Code recorded when it last updated this bundle. */
  lastUpdated: string | null;
}

export interface GitUpdateCheck extends UpdateCheckCommon {
  method: "git";
  /** The repository root, which may be the skill dir or the .claude dir above it. */
  repoRoot: string;
  remoteUrl: string | null;
  branch: string | null;
  /** e.g. `origin/main`, or null when the branch tracks nothing. */
  upstream: string | null;
  /** Commits the local branch is behind by, from refs already on disk. */
  behind: number | null;
  ahead: number | null;
  /** Uncommitted changes in the working tree — a pull may refuse. */
  dirty: boolean | null;
  /** When the remote was last contacted. Null means never, as far as we can see. */
  lastFetchedAt: Date | null;
  /** True when those refs are recent enough to be worth trusting. */
  refsAreFresh: boolean;
}

export interface ToolUpdateCheck extends UpdateCheckCommon {
  method: "tool";
  /** The version-marker file that named the command. */
  markerFile: string;
  markerVersion: string | null;
  toolName: string;
  toolPath: string;
  installedToolVersion: string | null;
}

export interface ManualUpdateCheck extends UpdateCheckCommon {
  method: "manual";
  lastModified: Date | null;
  /** Set when a marker file exists but no matching command is installed. */
  markerFile: string | null;
}

export type SkillUpdateCheck =
  | PluginUpdateCheck
  | GitUpdateCheck
  | ToolUpdateCheck
  | ManualUpdateCheck;

export interface UpdateOptions {
  /** Home directory to read plugin state from. Injected so tests never read the real ~/.claude. */
  home?: string;
  /** Environment for the PATH scan. */
  env?: Record<string, string | undefined>;
  /** How child processes run. Tests pass a stub and nothing is ever spawned. */
  exec?: ExecRunner;
  /** Clock, so "last checked 3 days ago" is testable. */
  now?: Date;
  /** How recent a fetch has to be before "no new commits" means "up to date". */
  freshRefsMs?: number;
}

/**
 * Git refs are a photograph, not a live feed. An hour keeps a just-pulled
 * clone honest without claiming anything about a clone last touched in March.
 */
export const DEFAULT_FRESH_REFS_MS = 60 * 60 * 1000;

interface ResolvedOptions {
  home: string;
  env: Record<string, string | undefined>;
  exec: ExecRunner;
  now: Date;
  freshRefsMs: number;
}

function resolveOptions(options: UpdateOptions | undefined): ResolvedOptions {
  return {
    home: options?.home ?? homedir(),
    env: options?.env ?? process.env,
    exec: options?.exec ?? defaultExec,
    now: options?.now ?? new Date(),
    freshRefsMs: options?.freshRefsMs ?? DEFAULT_FRESH_REFS_MS,
  };
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null; // missing or broken is just "no information"
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "3 days ago" beats an ISO timestamp for someone deciding whether to care. */
function describeAge(from: Date, now: Date): string {
  const ms = now.getTime() - from.getTime();
  if (ms < 0) return "just now";
  if (ms < MINUTE) return "moments ago";
  if (ms < HOUR) {
    const n = Math.max(1, Math.round(ms / MINUTE));
    return `${n} minute${n === 1 ? "" : "s"} ago`;
  }
  if (ms < DAY) {
    const n = Math.max(1, Math.round(ms / HOUR));
    return `${n} hour${n === 1 ? "" : "s"} ago`;
  }
  const n = Math.max(1, Math.round(ms / DAY));
  return `${n} day${n === 1 ? "" : "s"} ago`;
}

function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function makeCommand(argv: string[], needsRestart: boolean): UpdateCommand {
  return { argv, display: argv.join(" "), needsRestart };
}

function statOrNull(target: string): fs.Stats | null {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1. Plugin — installed bundle vs the marketplace catalogue on disk
// ---------------------------------------------------------------------------

interface InstalledPluginRecord {
  scope: string | null;
  installPath: string | null;
  version: string | null;
  lastUpdated: string | null;
}

function readInstalledPlugin(home: string, pluginId: string, skillPath: string): InstalledPluginRecord | null {
  const file = path.join(home, ".claude", "plugins", "installed_plugins.json");
  const plugins = asRecord(asRecord(readJsonFile(file))?.["plugins"]);
  const installs = plugins?.[pluginId];
  if (!Array.isArray(installs) || installs.length === 0) return null;

  const records: InstalledPluginRecord[] = [];
  for (const raw of installs) {
    const entry = asRecord(raw);
    if (!entry) continue;
    records.push({
      scope: asString(entry["scope"]),
      installPath: asString(entry["installPath"]),
      version: asString(entry["version"]),
      lastUpdated: asString(entry["lastUpdated"]) ?? asString(entry["installedAt"]),
    });
  }
  if (records.length === 0) return null;

  // The same bundle can be installed at several scopes; prefer the copy this
  // skill actually came out of.
  const owning = records.find((r) => r.installPath !== null && skillPath.startsWith(r.installPath + path.sep));
  return owning ?? records[0] ?? null;
}

interface CatalogEntry {
  version: string | null;
  ref: string | null;
  found: boolean;
}

function readCatalogEntry(home: string, marketplace: string, pluginName: string): CatalogEntry {
  const known = asRecord(readJsonFile(path.join(home, ".claude", "plugins", "known_marketplaces.json")));
  const installLocation = asString(asRecord(known?.[marketplace])?.["installLocation"]);
  if (!installLocation) return { version: null, ref: null, found: false };

  const catalog = asRecord(
    readJsonFile(path.join(installLocation, ".claude-plugin", "marketplace.json")),
  );
  const entries = catalog?.["plugins"];
  if (!Array.isArray(entries)) return { version: null, ref: null, found: false };

  for (const raw of entries) {
    const entry = asRecord(raw);
    if (!entry || entry["name"] !== pluginName) continue;
    // `source` is either a string path or an object describing a git source.
    const ref = asString(asRecord(entry["source"])?.["ref"]);
    return { version: asString(entry["version"]), ref, found: true };
  }
  return { version: null, ref: null, found: false };
}

function checkPlugin(
  skill: SkillInfo,
  dir: string,
  pluginId: string,
  options: ResolvedOptions,
): PluginUpdateCheck {
  const at = pluginId.lastIndexOf("@");
  const pluginName = at > 0 ? pluginId.slice(0, at) : pluginId;
  const marketplace = at > 0 ? pluginId.slice(at + 1) : "";

  const installed = readInstalledPlugin(options.home, pluginId, skill.filePath);
  const catalog = marketplace === ""
    ? { version: null, ref: null, found: false }
    : readCatalogEntry(options.home, marketplace, pluginName);

  const installedVersion = installed?.version ?? null;
  const catalogVersion = catalog.version;

  let status: UpdateStatus = "unknown";
  let summary = "Can't tell";
  let detail: string;

  if (!installed) {
    detail = `Claude Code has no installation record for ${pluginId}, so there is nothing to compare.`;
  } else if (!catalog.found) {
    detail = `The ${marketplace} catalogue on this computer has no entry for ${pluginName}, so there is nothing to compare it against.`;
  } else if (!catalogVersion) {
    // Most catalogue entries genuinely carry no version. That is a real
    // "unknown", and calling it "up to date" would be inventing information.
    detail =
      `You have ${installedVersion ?? "an unrecorded version"}. The ${marketplace} catalogue doesn't publish a version for ` +
      `${pluginName}, so nothing on this computer can say whether that is the latest.`;
  } else if (!installedVersion) {
    detail = `The catalogue lists ${catalogVersion}, but Claude Code didn't record which version you installed.`;
  } else {
    const order = compareVersions(installedVersion, catalogVersion);
    if (order === null) {
      detail = `You have ${installedVersion} and the catalogue lists ${catalogVersion}; those aren't version numbers that can be put in order.`;
    } else if (order < 0) {
      status = "behind";
      summary = `Update available: ${installedVersion} → ${catalogVersion}`;
      detail = `You have ${installedVersion}. The ${marketplace} catalogue lists ${catalogVersion}.`;
    } else if (order === 0) {
      status = "up-to-date";
      summary = `Up to date (${installedVersion})`;
      detail = `You have ${installedVersion}, which is what the ${marketplace} catalogue lists.`;
    } else {
      detail = `You have ${installedVersion}, which is newer than the ${catalogVersion} in the ${marketplace} catalogue — the catalogue copy is probably out of date.`;
    }
  }

  if (installed?.lastUpdated) {
    const when = new Date(installed.lastUpdated);
    if (!Number.isNaN(when.getTime())) {
      detail += ` Installed ${describeAge(when, options.now)}.`;
    }
  }

  // `claude plugin update <id>` is the supported way to move a bundle, but
  // only offer it if the CLI is actually here — no shelling out to find out.
  const claudePath = findOnPath("claude", options.env);
  const command = claudePath ? makeCommand(["claude", "plugin", "update", pluginId], true) : null;
  if (!claudePath) {
    detail += " The `claude` command isn't on your PATH, so there's nothing to run from here.";
  }

  return {
    skill,
    dir,
    method: "plugin",
    status,
    summary,
    detail,
    command,
    pluginId,
    pluginName,
    marketplace,
    installedVersion,
    catalogVersion,
    catalogRef: catalog.ref,
    installPath: installed?.installPath ?? null,
    lastUpdated: installed?.lastUpdated ?? null,
  };
}

// ---------------------------------------------------------------------------
// 2. Git — a clone, judged from refs already on disk
// ---------------------------------------------------------------------------

/**
 * Finds the repository the skill belongs to, without ever escaping the Claude
 * config tree. A skill dir can be its own clone, or one directory in a repo of
 * skills, or part of a dotfiles repo rooted at .claude — all three are real
 * update paths. What must never happen is walking up into the user's *project*
 * repo and offering to `git pull` their working code as a "skill update", so
 * the search stops at the nearest .claude directory and goes no further.
 */
export function findSkillRepoRoot(dir: string): string | null {
  const resolved = path.resolve(dir);
  const segments = resolved.split(path.sep);
  const claudeIndex = segments.lastIndexOf(".claude");
  const stopAt =
    claudeIndex === -1 ? resolved : segments.slice(0, claudeIndex + 1).join(path.sep) || path.sep;

  let current = resolved;
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return current; // a file too: worktrees
    if (current === stopAt) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function gitText(
  exec: ExecRunner,
  repoRoot: string,
  args: readonly string[],
): Promise<string | null> {
  // -C keeps the repo path an argv element rather than a cwd side effect, and
  // every subcommand used here only reads.
  const result = await exec("git", ["-C", repoRoot, ...args]);
  if (!result.ok) return null;
  const text = result.stdout.trim();
  return text === "" ? null : text;
}

async function readLastFetch(exec: ExecRunner, repoRoot: string): Promise<Date | null> {
  const gitDir = (await gitText(exec, repoRoot, ["rev-parse", "--absolute-git-dir"])) ??
    path.join(repoRoot, ".git");
  const stats = statOrNull(path.join(gitDir, "FETCH_HEAD"));
  return stats ? stats.mtime : null;
}

async function checkGit(
  skill: SkillInfo,
  dir: string,
  repoRoot: string,
  options: ResolvedOptions,
): Promise<GitUpdateCheck> {
  const { exec } = options;

  const branchRaw = await gitText(exec, repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchRaw === "HEAD" ? null : branchRaw; // detached
  const upstream = await gitText(exec, repoRoot, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);

  const remoteName = upstream?.includes("/") ? upstream.slice(0, upstream.indexOf("/")) : "origin";
  const remoteUrl = await gitText(exec, repoRoot, ["config", "--get", `remote.${remoteName}.url`]);
  const dirtyRaw = await exec("git", ["-C", repoRoot, "status", "--porcelain"]);
  const dirty = dirtyRaw.ok ? dirtyRaw.stdout.trim() !== "" : null;
  const lastFetchedAt = await readLastFetch(exec, repoRoot);

  let behind: number | null = null;
  let ahead: number | null = null;
  if (upstream) {
    // One call for both sides: `<behind>\t<ahead>` relative to HEAD.
    const counts = await gitText(exec, repoRoot, [
      "rev-list",
      "--left-right",
      "--count",
      `${upstream}...HEAD`,
    ]);
    const parts = counts?.split(/\s+/) ?? [];
    const left = Number(parts[0]);
    const right = Number(parts[1]);
    if (Number.isInteger(left) && Number.isInteger(right)) {
      behind = left;
      ahead = right;
    }
  }

  const refsAreFresh =
    lastFetchedAt !== null &&
    options.now.getTime() - lastFetchedAt.getTime() <= options.freshRefsMs;
  const checkedAge = lastFetchedAt ? describeAge(lastFetchedAt, options.now) : null;

  let status: UpdateStatus = "unknown";
  let summary = "Can't tell";
  let detail: string;
  const where = repoRoot === dir ? "This skill is a git clone" : `This skill lives in the git repo at ${repoRoot}`;
  const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;

  if (!upstream) {
    detail = `${where}, but its branch doesn't follow a remote, so there is nothing to compare against.`;
  } else if (behind === null) {
    detail = `${where}, but git couldn't compare ${branch ?? "HEAD"} with ${upstream}.`;
  } else if (behind > 0) {
    status = "behind";
    summary = `${commits(behind)} behind ${upstream}`;
    detail = checkedAge
      ? `${where}. It is ${commits(behind)} behind ${upstream}, last checked ${checkedAge}.`
      : `${where}. It is ${commits(behind)} behind ${upstream}, going by refs already on this computer — it has never contacted the remote itself.`;
  } else if (refsAreFresh) {
    status = "up-to-date";
    summary = `Up to date with ${upstream}`;
    detail = `${where}. Nothing new on ${upstream} as of ${checkedAge}.`;
  } else if (checkedAge) {
    // No new commits *in the refs we already have*. Without a fetch that is
    // not the same as "up to date", and saying so would be a guess.
    detail = `${where}. Nothing new in the copy of ${upstream} already on this computer, but that was last checked ${checkedAge} — check the remote to be sure.`;
  } else {
    detail = `${where}. Nothing new in the copy of ${upstream} already on this computer, but it has never contacted the remote, so that means very little — check the remote to be sure.`;
  }

  if (ahead !== null && ahead > 0) {
    detail += ` You have ${ahead} local commit${ahead === 1 ? "" : "s"} of your own.`;
  }
  if (dirty === true) {
    detail += " There are uncommitted changes here, so a pull may refuse until they are dealt with.";
  }

  return {
    skill,
    dir,
    method: "git",
    status,
    summary,
    detail,
    // --ff-only never rewrites or merges: worst case it refuses and nothing changed (C4).
    command: upstream ? makeCommand(["git", "-C", repoRoot, "pull", "--ff-only"], false) : null,
    repoRoot,
    remoteUrl,
    branch,
    upstream,
    behind,
    ahead,
    dirty,
    lastFetchedAt,
    refsAreFresh,
  };
}

export interface GitFetchOutcome {
  ok: boolean;
  /** Exactly what ran, so the UI can show it before and after (C5). */
  argv: string[];
  message: string;
}

/**
 * THE ONLY NETWORK CALL IN THIS MODULE, and the only one in ccpanel outside
 * the MCP registry search (C1). Never called by `checkSkillUpdate`; the UI has
 * to ask for it because the user asked for it. It fetches refs and writes
 * nothing to the working tree, so a fetch can never lose work.
 */
export async function fetchGitRemote(
  repoRoot: string,
  options?: UpdateOptions,
): Promise<GitFetchOutcome> {
  const resolved = resolveOptions(options);
  const argv = ["git", "-C", repoRoot, "fetch", "--quiet"];
  const result = await resolved.exec("git", argv.slice(1), { timeoutMs: FETCH_TIMEOUT_MS });
  if (result.ok) return { ok: true, argv, message: "Checked the remote." };
  if (result.failure === "missing") return { ok: false, argv, message: "git isn't installed." };
  if (result.failure === "timeout") return { ok: false, argv, message: "The remote didn't answer in time." };
  const reason = (result.stderr.trim() || result.stdout.trim()).split("\n")[0] ?? "git refused.";
  return { ok: false, argv, message: reason };
}

// ---------------------------------------------------------------------------
// 3. Tool — a version marker next to a command of the same name
// ---------------------------------------------------------------------------

/** Marker filenames that name no tool of their own — the directory names it. */
const GENERIC_MARKERS = new Set(["version", "version.txt", ".version", "version.lock"]);
/** `.<tool>_version`, `<tool>-version`, `<tool>.version`, with an optional .txt. */
const NAMED_MARKER = /^\.?([A-Za-z0-9][A-Za-z0-9.-]*?)[._-]version(?:\.txt)?$/i;

export interface VersionMarker {
  /** Absolute path to the marker file. */
  file: string;
  /** Contents, trimmed to a version if one can be read out of it. */
  version: string | null;
  /** Commands this marker could be talking about, best guess first. */
  candidates: string[];
}

/**
 * Looks for a file in the skill directory that records which version of some
 * tool the skill was installed for. This is what makes a hand-copied skill
 * checkable at all: the file names the command, the command reports its own
 * version, and the two can disagree.
 */
export function findVersionMarker(dir: string, skillName: string): VersionMarker | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  const dirName = path.basename(dir);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const lower = entry.name.toLowerCase();
    let candidates: string[] | null = null;

    if (GENERIC_MARKERS.has(lower) || lower === "version.md") {
      candidates = [dirName, skillName];
    } else {
      const named = NAMED_MARKER.exec(entry.name);
      if (named?.[1]) candidates = [named[1], dirName, skillName];
    }
    if (!candidates) continue;

    const file = path.join(dir, entry.name);
    let contents = "";
    try {
      contents = fs.readFileSync(file, "utf8");
    } catch {
      contents = "";
    }
    const unique = candidates.filter((c, i) => c !== "" && candidates.indexOf(c) === i);
    return { file, version: extractVersion(contents), candidates: unique };
  }
  return null;
}

/** Ranked most explicit first: a `self-update` means itself, `update` might not. */
const SELF_UPDATE_WORDS = ["self-update", "selfupdate", "self_update", "upgrade", "update"];
/** An indented listing line: two spaces, a word, then columns or arguments. */
const HELP_LINE = /^\s{1,8}([A-Za-z][A-Za-z0-9_-]*)(.*)$/;

/**
 * Reads a tool's own `--help` and returns the subcommand that updates the tool
 * itself, or null. We never assume `mytool update` exists: an invented command
 * printed as a suggestion is worse than admitting we don't know one.
 *
 * A listed subcommand that takes a required argument — `update <path>` — is
 * rejected, because it updates whatever you hand it, not itself.
 */
export function findSelfUpdateSubcommand(helpText: string): string | null {
  const found = new Map<string, boolean>();
  for (const line of helpText.split("\n")) {
    const match = HELP_LINE.exec(line);
    if (!match?.[1]) continue;
    const word = match[1].toLowerCase();
    if (!SELF_UPDATE_WORDS.includes(word)) continue;

    const rest = match[2] ?? "";
    // Only a columnar listing counts; a sentence starting with "update" doesn't.
    if (rest !== "" && !/^(\s{2,}|\s*[<[])/.test(rest)) continue;
    // The argument column is whatever comes before the description gap.
    const args = rest.split(/\s{2,}/)[0]?.trim() ?? "";
    const takesRequiredArg = /^<[^>]+>/.test(args);
    if (!found.has(word) || found.get(word) === false) found.set(word, !takesRequiredArg);
  }
  for (const word of SELF_UPDATE_WORDS) {
    if (found.get(word) === true) return word;
  }
  return null;
}

async function askForVersion(exec: ExecRunner, tool: string): Promise<string | null> {
  for (const args of [["--version"], ["version"]]) {
    const result = await exec(tool, args);
    if (result.failure === "missing") return null;
    const version = extractVersion(`${result.stdout}\n${result.stderr}`);
    if (version) return version;
  }
  return null;
}

async function readHelp(exec: ExecRunner, tool: string): Promise<string | null> {
  for (const args of [["--help"], ["help"]]) {
    const result = await exec(tool, args);
    if (result.failure === "missing") return null;
    const text = `${result.stdout}\n${result.stderr}`.trim();
    if (text !== "") return text;
  }
  return null;
}

async function checkTool(
  skill: SkillInfo,
  dir: string,
  marker: VersionMarker,
  toolName: string,
  toolPath: string,
  options: ResolvedOptions,
): Promise<ToolUpdateCheck> {
  const installedToolVersion = await askForVersion(options.exec, toolName);
  const markerVersion = marker.version;
  const markerFileName = path.basename(marker.file);

  let status: UpdateStatus = "unknown";
  let summary = "Can't tell";
  let detail: string;

  if (!markerVersion) {
    detail = `${markerFileName} doesn't contain a version that can be read, so there is nothing to compare with the ${toolName} on your PATH.`;
  } else if (!installedToolVersion) {
    detail = `This skill was installed for ${toolName} ${markerVersion}, but ${toolName} didn't report a version, so there is nothing to compare.`;
  } else {
    const order = compareVersions(markerVersion, installedToolVersion);
    if (order === null) {
      detail = `This skill records ${markerVersion} and ${toolName} reports ${installedToolVersion}; those can't be put in order.`;
    } else if (order < 0) {
      status = "behind";
      summary = `Update available: ${markerVersion} → ${installedToolVersion}`;
      detail = `These skill files were installed for ${toolName} ${markerVersion}, but the ${toolName} on your PATH is ${installedToolVersion}. Reinstall the skill from the newer ${toolName} to catch up.`;
    } else if (order === 0) {
      status = "up-to-date";
      summary = `Up to date (${markerVersion})`;
      detail = `These skill files match the ${toolName} ${installedToolVersion} on your PATH.`;
    } else {
      // The skill is ahead of the binary. Something is stale, but it isn't the
      // skill, and guessing which way the user wants it resolved is not ours.
      detail = `These skill files are from ${toolName} ${markerVersion}, which is newer than the ${installedToolVersion} on your PATH — the command is the older half here.`;
    }
  }

  const help = await readHelp(options.exec, toolName);
  const subcommand = help ? findSelfUpdateSubcommand(help) : null;
  const command = subcommand ? makeCommand([toolName, subcommand], false) : null;
  if (!command) {
    detail += ` ${toolName} doesn't list a command for updating itself, so how it gets updated is up to however you installed it.`;
  }

  return {
    skill,
    dir,
    method: "tool",
    status,
    summary,
    detail,
    command,
    markerFile: marker.file,
    markerVersion,
    toolName,
    toolPath,
    installedToolVersion,
  };
}

// ---------------------------------------------------------------------------
// 4. Manual — nothing on disk knows where this came from
// ---------------------------------------------------------------------------

function checkManual(
  skill: SkillInfo,
  dir: string,
  marker: VersionMarker | null,
  options: ResolvedOptions,
): ManualUpdateCheck {
  const fileStats = statOrNull(skill.filePath);
  const dirStats = statOrNull(dir);
  const times = [fileStats?.mtime, dirStats?.mtime].filter((d): d is Date => d instanceof Date);
  const lastModified = times.length
    ? times.reduce((newest, d) => (d > newest ? d : newest))
    : null;

  let detail = `Nothing on this computer records where this skill came from — it isn't part of an installed bundle, it isn't a git clone, and there's no version file next to it. It lives in ${dir}`;
  detail += lastModified
    ? `, last changed on ${formatDay(lastModified)} (${describeAge(lastModified, options.now)}).`
    : ".";
  if (marker) {
    detail += ` There is a ${path.basename(marker.file)} here, but no matching command is installed, so it can't be checked.`;
  }

  return {
    skill,
    dir,
    method: "manual",
    status: "unknown",
    summary: lastModified ? `No update path — last changed ${formatDay(lastModified)}` : "No update path",
    detail,
    command: null,
    lastModified,
    markerFile: marker?.file ?? null,
  };
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * Works out whether one skill is out of date and how it could be updated,
 * trying the four kinds of evidence in order of how much they actually prove.
 */
export async function checkSkillUpdate(
  skill: SkillInfo,
  options?: UpdateOptions,
): Promise<SkillUpdateCheck> {
  const resolved = resolveOptions(options);
  const dir = path.dirname(skill.filePath);

  // 1. An installed bundle records its own version, and Claude Code owns it.
  if (skill.source === "plugin" && skill.pluginId) {
    return checkPlugin(skill, dir, skill.pluginId, resolved);
  }

  // 2. A clone can be compared against refs already on disk, no network.
  const repoRoot = findSkillRepoRoot(dir);
  if (repoRoot) return checkGit(skill, dir, repoRoot, resolved);

  // 3. A marker file plus a command of that name is a real, checkable signal.
  const marker = findVersionMarker(dir, skill.name);
  if (marker) {
    for (const candidate of marker.candidates) {
      const toolPath = findOnPath(candidate, resolved.env);
      if (toolPath) return checkTool(skill, dir, marker, candidate, toolPath, resolved);
    }
  }

  // 4. Say what is true — where it is and when it changed — and nothing more.
  return checkManual(skill, dir, marker, resolved);
}

/**
 * Checks a whole list. Deliberately one at a time: each check can spawn a few
 * short-lived processes, and forty of them at once to answer a screen nobody
 * has scrolled to yet is not a trade worth making.
 */
export async function listSkillUpdates(
  skills: readonly SkillInfo[],
  options?: UpdateOptions,
): Promise<SkillUpdateCheck[]> {
  const out: SkillUpdateCheck[] = [];
  for (const skill of skills) out.push(await checkSkillUpdate(skill, options));
  return out;
}

export interface UpdateSummary {
  behind: number;
  upToDate: number;
  unknown: number;
  /** Out of date *and* we can offer something to run about it. */
  actionable: number;
}

export function summarizeUpdates(checks: readonly SkillUpdateCheck[]): UpdateSummary {
  const summary: UpdateSummary = { behind: 0, upToDate: 0, unknown: 0, actionable: 0 };
  for (const check of checks) {
    if (check.status === "behind") summary.behind++;
    else if (check.status === "up-to-date") summary.upToDate++;
    else summary.unknown++;
    if (check.status === "behind" && check.command) summary.actionable++;
  }
  return summary;
}
