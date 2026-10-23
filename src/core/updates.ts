import path from "node:path";
import type { SkillInfo } from "./skills.js";
import { findOnPath } from "./updates/exec.js";
import { checkGit, findSkillRepoRoot } from "./updates/git.js";
import { checkPlugin } from "./updates/plugin.js";
import { checkManual, checkTool, findVersionMarker } from "./updates/tool.js";
import { resolveOptions, type SkillUpdateCheck, type UpdateOptions } from "./updates/types.js";

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

export {
  defaultExec,
  type ExecOptions,
  type ExecResult,
  type ExecRunner,
  findOnPath,
} from "./updates/exec.js";
export {
  fetchGitRemote,
  findSkillRepoRoot,
  GIT_HARDENING_ARGS,
  GIT_HARDENING_ENV,
  type GitFetchOutcome,
} from "./updates/git.js";
export { findSelfUpdateSubcommand, findVersionMarker, type VersionMarker } from "./updates/tool.js";
export {
  DEFAULT_FRESH_REFS_MS,
  type GitUpdateCheck,
  type ManualUpdateCheck,
  type PluginUpdateCheck,
  type SkillUpdateCheck,
  type ToolUpdateCheck,
  type UpdateCommand,
  type UpdateMethod,
  type UpdateOptions,
  type UpdateStatus,
} from "./updates/types.js";
export { compareVersions, extractVersion, isComparableVersion } from "./updates/versions.js";

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
  // Only for the user's own skills: a project's .claude/skills came with the
  // repo the user just opened, and its .git/config is a stranger's to write.
  // Even hardened, running git there on screen-open is a risk with nothing to
  // gain — the project's own git workflow already updates those files.
  const repoRoot = skill.source === "project" ? null : findSkillRepoRoot(dir);
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
