import fs from "node:fs";
import path from "node:path";
import { type ClaudePaths, type RepoInfo, getClaudePaths, resolvePaths } from "./paths.js";

export type RungId =
  | "instructions"
  | "permissions"
  | "commands"
  | "skills"
  | "helpers"
  | "tools"
  | "automaticChecks"
  | "memory"
  | "parallelWork";

/** Order matches the 3x3 grid in the spec's Ladder mockup (§10.1). */
export const RUNG_ORDER: RungId[] = [
  "instructions",
  "permissions",
  "commands",
  "skills",
  "helpers",
  "tools",
  "automaticChecks",
  "memory",
  "parallelWork",
];

export const RUNG_LABELS: Record<RungId, string> = {
  instructions: "Project instructions",
  permissions: "Permissions",
  commands: "Commands",
  skills: "Skills",
  helpers: "Helpers",
  tools: "Tools",
  automaticChecks: "Automatic checks",
  memory: "Memory",
  parallelWork: "Parallel work",
};

export interface LadderState {
  rungs: Record<RungId, boolean>;
  countOn: number;
  countTotal: number;
  repo: RepoInfo;
  /** Rungs detected via project- or user-scope files that failed to parse as
   * JSON. Not acted on in M1 — surfaced for a future Repair screen. */
  parseWarnings: string[];
}

function readJsonSafe(filePath: string, warnings: string[]): unknown | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null; // missing file is not a warning
  }
  try {
    return JSON.parse(raw);
  } catch {
    warnings.push(filePath);
    return null;
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isNonEmptyArray(x: unknown): boolean {
  return Array.isArray(x) && x.length > 0;
}

function isNonEmptyObject(x: unknown): boolean {
  return isRecord(x) && Object.keys(x).length > 0;
}

function dirHasFileMatching(dirPath: string, predicate: (name: string) => boolean): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((e) => e.isFile() && predicate(e.name));
}

function hasAnySkill(skillsDir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some(
    (e) => e.isDirectory() && fs.existsSync(path.join(skillsDir, e.name, "SKILL.md")),
  );
}

/** Subagent dirs are scanned recursively (Claude Code does the same, so a
 * definition in agents/review/foo.md still counts). Bounded depth as a
 * safety net against pathological trees, not because deep nesting is normal. */
function hasMarkdownRecursive(dir: string, maxDepth = 6): boolean {
  function walk(d: string, depth: number): boolean {
    if (depth > maxDepth) return false;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".md")) return true;
    }
    for (const e of entries) {
      if (e.isDirectory() && walk(path.join(d, e.name), depth + 1)) return true;
    }
    return false;
  }
  return walk(dir, 0);
}

function anySettingsScope(
  scopes: Array<Record<string, unknown> | null>,
  check: (settings: Record<string, unknown>) => boolean,
): boolean {
  return scopes.some((s) => s !== null && check(s));
}

export function detectLadderState(cwd: string = process.cwd()): LadderState {
  const repo = resolvePaths(cwd);
  const paths: ClaudePaths = getClaudePaths(repo);
  const warnings: string[] = [];

  const userSettings = readJsonSafe(paths.userSettings, warnings);
  const projectSettings = readJsonSafe(paths.projectSettings, warnings);
  const localSettings = readJsonSafe(paths.localSettings, warnings);
  const settingsScopes = [userSettings, projectSettings, localSettings].map((s) =>
    isRecord(s) ? s : null,
  );

  // --- instructions -------------------------------------------------------
  const instructions =
    paths.projectClaudeMdCandidates.some((p) => fs.existsSync(p)) ||
    fs.existsSync(paths.projectClaudeLocalMd) ||
    fs.existsSync(paths.userClaudeMd);

  // --- permissions ---------------------------------------------------------
  const permissions = anySettingsScope(settingsScopes, (s) => {
    const perms = s["permissions"];
    if (!isRecord(perms)) return false;
    return (
      isNonEmptyArray(perms["allow"]) ||
      isNonEmptyArray(perms["deny"]) ||
      isNonEmptyArray(perms["ask"])
    );
  });

  // --- commands (legacy .claude/commands/*.md, project + user scope) ------
  const commands =
    paths.projectCommandsDirs.some((d) => dirHasFileMatching(d, (n) => n.endsWith(".md"))) ||
    dirHasFileMatching(paths.userCommandsDir, (n) => n.endsWith(".md"));

  // --- skills (.claude/skills/<name>/SKILL.md, project + user scope) ------
  const skills =
    paths.projectSkillsDirs.some((d) => hasAnySkill(d)) || hasAnySkill(paths.userSkillsDir);

  // --- helpers (subagents, .claude/agents/*.md, project + user scope) -----
  const helpers =
    paths.projectAgentsDirs.some((d) => hasMarkdownRecursive(d)) ||
    hasMarkdownRecursive(paths.userAgentsDir);

  // --- tools (MCP servers: project .mcp.json, or ~/.claude.json user/local)
  const projectMcp = readJsonSafe(paths.projectMcp, warnings);
  const claudeJson = readJsonSafe(paths.userClaudeJson, warnings);
  let tools = isRecord(projectMcp) && isNonEmptyObject(projectMcp["mcpServers"]);
  if (!tools && isRecord(claudeJson)) {
    // User scope: top-level mcpServers in ~/.claude.json, shared across all projects.
    if (isNonEmptyObject(claudeJson["mcpServers"])) tools = true;
    // Local scope: keyed by the project path under `projects`.
    const projects = claudeJson["projects"];
    if (!tools && isRecord(projects)) {
      for (const key of [repo.projectDir, repo.cwd]) {
        const entry = projects[key];
        if (isRecord(entry) && isNonEmptyObject(entry["mcpServers"])) {
          tools = true;
          break;
        }
      }
    }
  }

  // --- automatic checks (hooks configured in any settings scope) ----------
  const automaticChecks = anySettingsScope(settingsScopes, (s) => {
    const hooks = s["hooks"];
    if (!isRecord(hooks)) return false;
    return Object.values(hooks).some((v) => isNonEmptyArray(v));
  });

  // --- memory (explicit autocompact tuning, or a "name-only" skill) -------
  const memory = anySettingsScope(settingsScopes, (s) => {
    if ("autoCompactEnabled" in s || "autoCompactWindow" in s) return true;
    const overrides = s["skillOverrides"];
    if (isRecord(overrides)) {
      return Object.values(overrides).some((v) => v === "name-only");
    }
    return false;
  });

  // --- parallel work --------------------------------------------------------
  // No local-file signal exists for this in v1: running subagents in parallel
  // is a technique used within a live session, not something that leaves a
  // durable trace on disk. Always "not yet" until there's a grounded way to
  // detect it — see the M1 report for why this isn't guessed at.
  const parallelWork = false;

  const rungs: Record<RungId, boolean> = {
    instructions,
    permissions,
    commands,
    skills,
    helpers,
    tools,
    automaticChecks,
    memory,
    parallelWork,
  };

  const countOn = RUNG_ORDER.reduce((n, r) => n + (rungs[r] ? 1 : 0), 0);

  return {
    rungs,
    countOn,
    countTotal: RUNG_ORDER.length,
    repo,
    parseWarnings: warnings,
  };
}
