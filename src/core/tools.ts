import fs from "node:fs";
import { type RepoInfo, getClaudePaths } from "./paths.js";

/**
 * Finding the tools (MCP servers) this project can reach, and being honest
 * about which of them we can actually switch (§5.5, §10.5).
 */

export type ToolScope = "project" | "user" | "local";

/**
 * Which of Claude Code's two switches turns a given server off.
 *
 * `mcpjson` — `disabledMcpjsonServers` in settings.json. Only covers servers
 *   that came from a .mcp.json, but it lives in the project and can be shared
 *   with the team, so it stays the default for those.
 * `projectDeny` — `disabledMcpServers` under `projects[<dir>]` in
 *   ~/.claude.json. A deny-list of server *names* that applies whatever scope
 *   defined the server, which is what makes a user-scope server switchable at
 *   all. This is the switch Claude Code's own /mcp menu writes.
 */
export type ToolSwitch = "mcpjson" | "projectDeny";

export interface ToolInfo {
  name: string;
  scope: ToolScope;
  /** How it starts, masked before display. */
  summary: string;
  /** Every server can be switched now; kept so callers can still ask. */
  switchable: boolean;
  /** Which mechanism a toggle should use for this server. */
  switch: ToolSwitch;
  enabled: boolean;
  /**
   * How to delete the server outright, as opposed to switching it off.
   * Still shown, because "off" and "gone" are different things.
   */
  removeCommand: string | null;
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function summarise(server: unknown): string {
  if (typeof server !== "object" || server === null) return "";
  const s = server as { command?: unknown; args?: unknown; url?: unknown; type?: unknown };
  if (typeof s.url === "string") return s.url;
  if (typeof s.command === "string") {
    const args = Array.isArray(s.args) ? s.args.filter((a) => typeof a === "string").join(" ") : "";
    return `${s.command} ${args}`.trim();
  }
  return typeof s.type === "string" ? s.type : "";
}

/** Servers switched off through disabledMcpjsonServers, from any scope. */
export function disabledProjectServers(repo: RepoInfo): Set<string> {
  const paths = getClaudePaths(repo);
  const disabled = new Set<string>();
  for (const file of [paths.userSettings, paths.projectSettings, paths.localSettings]) {
    const settings = readJson(file);
    const list = settings?.["disabledMcpjsonServers"];
    if (Array.isArray(list)) for (const n of list) if (typeof n === "string") disabled.add(n);
  }
  return disabled;
}

/**
 * The key Claude Code files this folder under in ~/.claude.json.
 *
 * Read out of the shipped binary: the key is the git root of the directory
 * Claude Code was started in, falling back to that directory itself — the
 * same rule paths.ts already applies for projectDir. Checked against this
 * machine's real ~/.claude.json, where 25 of 25 existing keys are git roots
 * and none is a subdirectory of one.
 *
 * An existing key still wins, so a folder Claude Code already recorded under
 * some other spelling keeps working instead of gaining a second entry.
 */
export function projectConfigKey(repo: RepoInfo, claudeJson?: Record<string, unknown> | null): string {
  const json = claudeJson === undefined ? readJson(getClaudePaths(repo).userClaudeJson) : claudeJson;
  const projects = json?.["projects"];
  if (typeof projects === "object" && projects !== null) {
    for (const key of [repo.projectDir, repo.cwd]) {
      if (key in (projects as Record<string, unknown>)) return key;
    }
  }
  return repo.projectDir;
}

/**
 * Servers denied by name for this folder, via projects[<dir>].disabledMcpServers.
 * Applies regardless of the scope that defined the server.
 */
export function deniedServers(repo: RepoInfo): Set<string> {
  const denied = new Set<string>();
  const json = readJson(getClaudePaths(repo).userClaudeJson);
  const projects = json?.["projects"];
  if (typeof projects !== "object" || projects === null) return denied;
  const entry = (projects as Record<string, unknown>)[projectConfigKey(repo, json)];
  const list = (entry as { disabledMcpServers?: unknown } | undefined)?.disabledMcpServers;
  if (Array.isArray(list)) for (const n of list) if (typeof n === "string") denied.add(n);
  return denied;
}

export function listTools(repo: RepoInfo): ToolInfo[] {
  const paths = getClaudePaths(repo);
  const out: ToolInfo[] = [];
  const disabled = disabledProjectServers(repo);
  // A name on the deny-list is off no matter which scope defined it, so this
  // is folded into `enabled` for every server below, not just the local ones.
  const denied = deniedServers(repo);

  // This folder — from .mcp.json, and the only ones we can switch.
  const projectMcp = readJson(paths.projectMcp);
  const projectServers = projectMcp?.["mcpServers"];
  if (typeof projectServers === "object" && projectServers !== null) {
    for (const [name, server] of Object.entries(projectServers as Record<string, unknown>)) {
      out.push({
        name,
        scope: "project",
        summary: summarise(server),
        switchable: true,
        switch: "mcpjson",
        enabled: !disabled.has(name) && !denied.has(name),
        removeCommand: null,
      });
    }
  }

  // All folders, and this-folder-just-for-you — both live in ~/.claude.json.
  const claudeJson = readJson(paths.userClaudeJson);
  if (claudeJson) {
    const userServers = claudeJson["mcpServers"];
    if (typeof userServers === "object" && userServers !== null) {
      for (const [name, server] of Object.entries(userServers as Record<string, unknown>)) {
        out.push({
          name,
          scope: "user",
          summary: summarise(server),
          switchable: true,
          switch: "projectDeny",
          enabled: !denied.has(name),
          removeCommand: `claude mcp remove ${name} -s user`,
        });
      }
    }

    const projects = claudeJson["projects"];
    if (typeof projects === "object" && projects !== null) {
      const entry = (projects as Record<string, unknown>)[projectConfigKey(repo, claudeJson)];
      const local = (entry as { mcpServers?: unknown } | undefined)?.mcpServers;
      if (typeof local === "object" && local !== null) {
        for (const [name, server] of Object.entries(local as Record<string, unknown>)) {
          if (out.some((t) => t.name === name && t.scope === "local")) continue;
          out.push({
            name,
            scope: "local",
            summary: summarise(server),
            switchable: true,
            switch: "projectDeny",
            enabled: !denied.has(name),
            removeCommand: `claude mcp remove ${name}`,
          });
        }
      }
    }
  }

  return out;
}

export const SCOPE_HEADING: Record<ToolScope, string> = {
  project: "This folder",
  user: "All your folders",
  local: "This folder, just for you",
};

/** True when claude.ai's own connectors are switched off everywhere (§5.3). */
export function connectorsDisabled(repo: RepoInfo): boolean {
  const paths = getClaudePaths(repo);
  for (const file of [paths.userSettings, paths.projectSettings, paths.localSettings]) {
    if (readJson(file)?.["disableClaudeAiConnectors"] === true) return true;
  }
  return false;
}
