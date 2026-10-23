import fs from "node:fs";
import path from "node:path";
import type { SkillInfo } from "../skills.js";
import { type ExecRunner, FETCH_TIMEOUT_MS } from "./exec.js";
import {
  type GitUpdateCheck,
  type ResolvedOptions,
  resolveOptions,
  type UpdateOptions,
  type UpdateStatus,
} from "./types.js";
import { describeAge, makeCommand, statOrNull } from "./util.js";

/** Checker 2: a git clone, judged from refs already on disk. Part of core/updates.ts — see the overview there. */

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

export async function gitText(
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

export async function readLastFetch(exec: ExecRunner, repoRoot: string): Promise<Date | null> {
  const gitDir =
    (await gitText(exec, repoRoot, ["rev-parse", "--absolute-git-dir"])) ??
    path.join(repoRoot, ".git");
  const stats = statOrNull(path.join(gitDir, "FETCH_HEAD"));
  return stats ? stats.mtime : null;
}

export async function checkGit(
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
  const where =
    repoRoot === dir
      ? "This skill is a git clone"
      : `This skill lives in the git repo at ${repoRoot}`;
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
    detail +=
      " There are uncommitted changes here, so a pull may refuse until they are dealt with.";
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
  if (result.failure === "timeout")
    return { ok: false, argv, message: "The remote didn't answer in time." };
  const reason = (result.stderr.trim() || result.stdout.trim()).split("\n")[0] ?? "git refused.";
  return { ok: false, argv, message: reason };
}
