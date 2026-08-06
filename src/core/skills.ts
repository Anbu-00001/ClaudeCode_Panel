import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { type RepoInfo, getClaudePaths } from "./paths.js";
import type { SkillOverrideState } from "./validate.js";

/**
 * Finding the abilities this project can use, and how much of Claude's memory
 * each one takes up (§10.5, §10.7).
 */

export type SkillSource = "project" | "user" | "plugin";

export interface SkillInfo {
  name: string;
  description: string;
  source: SkillSource;
  filePath: string;
  /** Set for plugin skills: `plugin@marketplace`. */
  pluginId: string | null;
  /** Plugin skills cannot be switched here — `/plugin` owns them (§5.3). */
  switchable: boolean;
  /** Frontmatter the skill sets itself, which the override can't undo. */
  disablesModelInvocation: boolean;
  userInvocable: boolean;
  /** Roughly how much of Claude's memory the description costs every session. */
  weight: "a little" | "some" | "a lot";
  descriptionChars: number;
}

/** Reads YAML frontmatter, returning {} when there is none or it is broken. */
export function readFrontmatter(filePath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return {};
  }
  if (!raw.startsWith("---")) return {};
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return {};
  try {
    const parsed: unknown = parseYaml(raw.slice(3, end));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {}; // a malformed skill is listed, never crashes the screen
  }
}

/**
 * Claude Code caps each skill's listed text at 1,536 characters, and a
 * description is re-read every session. Longer description, more of Claude's
 * memory gone before you type anything. Reported in words, never dollars —
 * per-skill cost does not exist in the data (§10.7).
 */
/**
 * Thresholds in characters of description. Claude Code caps each listed skill
 * at 1,536 characters, so these split that range into three bands rather than
 * being picked arbitrarily.
 */
const WEIGHT_LITTLE_MAX = 200;
const WEIGHT_SOME_MAX = 600;

function weigh(chars: number): SkillInfo["weight"] {
  if (chars < WEIGHT_LITTLE_MAX) return "a little";
  if (chars < WEIGHT_SOME_MAX) return "some";
  return "a lot";
}

function readSkillDir(dir: string, source: SkillSource, pluginId: string | null): SkillInfo[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: SkillInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(dir, entry.name, "SKILL.md");
    if (!fs.existsSync(filePath)) continue;

    const fm = readFrontmatter(filePath);
    const description = typeof fm["description"] === "string" ? fm["description"] : "";
    const name = typeof fm["name"] === "string" ? fm["name"] : entry.name;

    out.push({
      name,
      description,
      source,
      filePath,
      pluginId,
      switchable: source !== "plugin",
      disablesModelInvocation: fm["disable-model-invocation"] === true,
      userInvocable: fm["user-invocable"] !== false,
      weight: weigh(description.length),
      descriptionChars: description.length,
    });
  }
  return out;
}

/** Skills that came from an installed bundle, which `/plugin` manages. */
function readPluginSkills(): SkillInfo[] {
  const file = path.join(homedir(), ".claude", "plugins", "installed_plugins.json");
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const plugins = (data as { plugins?: Record<string, unknown> })?.plugins;
  if (typeof plugins !== "object" || plugins === null) return [];

  const out: SkillInfo[] = [];
  for (const [pluginId, installs] of Object.entries(plugins)) {
    if (!Array.isArray(installs)) continue;
    for (const install of installs) {
      const installPath = (install as { installPath?: unknown })?.installPath;
      if (typeof installPath !== "string") continue;
      out.push(...readSkillDir(path.join(installPath, "skills"), "plugin", pluginId));
    }
  }
  return out;
}

/**
 * Every ability available here. A project skill shadows a user skill of the
 * same name, matching how Claude Code resolves them.
 */
export function listSkills(repo: RepoInfo): SkillInfo[] {
  const paths = getClaudePaths(repo);
  const found: SkillInfo[] = [];
  for (const dir of paths.projectSkillsDirs) found.push(...readSkillDir(dir, "project", null));
  found.push(...readSkillDir(paths.userSkillsDir, "user", null));
  found.push(...readPluginSkills());

  const seen = new Set<string>();
  const unique: SkillInfo[] = [];
  for (const skill of found) {
    const key = `${skill.pluginId ?? ""}:${skill.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(skill);
  }
  return unique.sort((a, b) => a.name.localeCompare(b.name));
}

/** The four states, in the order Space cycles through them (§10.5). */
export const STATE_CYCLE: SkillOverrideState[] = ["on", "name-only", "user-invocable-only", "off"];

export const STATE_LABEL: Record<SkillOverrideState, string> = {
  on: "On",
  "name-only": "Quiet",
  "user-invocable-only": "Only when you ask",
  off: "Off",
};

export const STATE_SUBLABEL: Record<SkillOverrideState, string> = {
  on: "Claude can use this, and you can type it as a command",
  "name-only": "Still works, uses less of Claude's memory",
  "user-invocable-only": "Claude won't reach for it on its own",
  off: "Hidden completely",
};

export function nextState(current: SkillOverrideState): SkillOverrideState {
  const i = STATE_CYCLE.indexOf(current);
  return STATE_CYCLE[(i + 1) % STATE_CYCLE.length] as SkillOverrideState;
}

/** A skill absent from skillOverrides is treated as "on" (verified in docs). */
export function stateOf(
  overrides: Record<string, unknown> | undefined,
  skillName: string,
): SkillOverrideState {
  const value = overrides?.[skillName];
  return STATE_CYCLE.includes(value as SkillOverrideState) ? (value as SkillOverrideState) : "on";
}
