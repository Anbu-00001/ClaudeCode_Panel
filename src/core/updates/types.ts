import { homedir } from "node:os";
import type { SkillInfo } from "../skills.js";
import { defaultExec, type ExecRunner } from "./exec.js";

/** The shape of an update check, and its options. Part of core/updates.ts — see the overview there. */

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

export interface UpdateCheckCommon {
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

export interface ResolvedOptions {
  home: string;
  env: Record<string, string | undefined>;
  exec: ExecRunner;
  now: Date;
  freshRefsMs: number;
}

export function resolveOptions(options: UpdateOptions | undefined): ResolvedOptions {
  return {
    home: options?.home ?? homedir(),
    env: options?.env ?? process.env,
    exec: options?.exec ?? defaultExec,
    now: options?.now ?? new Date(),
    freshRefsMs: options?.freshRefsMs ?? DEFAULT_FRESH_REFS_MS,
  };
}
