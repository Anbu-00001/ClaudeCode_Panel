import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Resolves where "this project" is on disk, following the same rule Claude
 * Code itself uses for .claude/settings.local.json: the git repository root
 * (through worktrees), falling back to cwd outside a repo or when the repo
 * root resolves to the user's home directory.
 */
export interface RepoInfo {
  cwd: string;
  isGitRepo: boolean;
  gitRoot: string | null;
  projectDir: string;
  /** projectDir (index 0) down to cwd (last), inclusive — used to scan every
   * nested .claude/<thing>/ dir Claude Code itself would discover by walking
   * up from cwd to the repo root. */
  ancestorDirs: string[];
}

function resolveGitRoot(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function realOrResolved(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function buildAncestorChain(topDir: string, innerDir: string): string[] {
  const top = path.resolve(topDir);
  const inner = path.resolve(innerDir);

  const rel = path.relative(top, inner);
  if (rel === "") return [top];
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    // inner isn't under top (shouldn't happen in practice) — don't fabricate a chain
    return [top, inner];
  }

  const parts = rel.split(path.sep);
  const chain: string[] = [top];
  let acc = top;
  for (const part of parts) {
    acc = path.join(acc, part);
    chain.push(acc);
  }
  return chain;
}

export function resolvePaths(cwd: string = process.cwd()): RepoInfo {
  const resolvedCwd = realOrResolved(cwd);
  const home = path.resolve(homedir());
  const rawGitRoot = resolveGitRoot(resolvedCwd);

  let gitRoot: string | null = null;
  let isGitRepo = false;

  if (rawGitRoot) {
    const normalizedRoot = realOrResolved(rawGitRoot);
    if (normalizedRoot !== home) {
      gitRoot = normalizedRoot;
      isGitRepo = true;
    }
  }

  const projectDir = gitRoot ?? resolvedCwd;

  return {
    cwd: resolvedCwd,
    isGitRepo,
    gitRoot,
    projectDir,
    ancestorDirs: buildAncestorChain(projectDir, resolvedCwd),
  };
}

/** Every file/directory location ccpanel reads or (in later milestones) writes. */
export interface ClaudePaths {
  userSettings: string;
  projectSettings: string;
  localSettings: string;
  userClaudeJson: string;
  projectMcp: string;
  userSkillsDir: string;
  projectSkillsDirs: string[];
  userAgentsDir: string;
  projectAgentsDirs: string[];
  userCommandsDir: string;
  projectCommandsDirs: string[];
  userClaudeMd: string;
  projectClaudeMdCandidates: string[];
  projectClaudeLocalMd: string;
}

export function getClaudePaths(repo: RepoInfo): ClaudePaths {
  const home = homedir();
  return {
    userSettings: path.join(home, ".claude", "settings.json"),
    projectSettings: path.join(repo.projectDir, ".claude", "settings.json"),
    localSettings: path.join(repo.projectDir, ".claude", "settings.local.json"),
    userClaudeJson: path.join(home, ".claude.json"),
    projectMcp: path.join(repo.projectDir, ".mcp.json"),
    userSkillsDir: path.join(home, ".claude", "skills"),
    projectSkillsDirs: repo.ancestorDirs.map((d) => path.join(d, ".claude", "skills")),
    userAgentsDir: path.join(home, ".claude", "agents"),
    projectAgentsDirs: repo.ancestorDirs.map((d) => path.join(d, ".claude", "agents")),
    userCommandsDir: path.join(home, ".claude", "commands"),
    projectCommandsDirs: repo.ancestorDirs.map((d) => path.join(d, ".claude", "commands")),
    userClaudeMd: path.join(home, ".claude", "CLAUDE.md"),
    projectClaudeMdCandidates: [
      path.join(repo.projectDir, "CLAUDE.md"),
      path.join(repo.projectDir, ".claude", "CLAUDE.md"),
    ],
    projectClaudeLocalMd: path.join(repo.projectDir, "CLAUDE.local.md"),
  };
}
