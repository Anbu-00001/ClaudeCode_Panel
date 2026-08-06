import fs from "node:fs";
import { type RepoInfo, getClaudePaths } from "./paths.js";

/**
 * Finding the tools (MCP servers) this project can reach, and being honest
 * about which of them we can actually switch (§5.5, §10.5).
 */

export type ToolScope = "project" | "user" | "local";

export interface ToolInfo {
  name: string;
  scope: ToolScope;
  /** How it starts, masked before display. */
  summary: string;
  /**
   * Only servers from .mcp.json can be switched, via disabledMcpjsonServers.
   * User- and local-scope servers live in ~/.claude.json, which v1 never
   * writes — there is no per-server switch for them a normal user can use.
   */
  switchable: boolean;
  enabled: boolean;
  /** Shown when the user presses Space on something we can't switch. */
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

export function listTools(repo: RepoInfo): ToolInfo[] {
  const paths = getClaudePaths(repo);
  const out: ToolInfo[] = [];
  const disabled = disabledProjectServers(repo);

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
        enabled: !disabled.has(name),
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
          switchable: false,
          enabled: true,
          removeCommand: `claude mcp remove ${name} -s user`,
        });
      }
    }

    const projects = claudeJson["projects"];
    if (typeof projects === "object" && projects !== null) {
      for (const key of [repo.projectDir, repo.cwd]) {
        const entry = (projects as Record<string, unknown>)[key];
        const local = (entry as { mcpServers?: unknown } | undefined)?.mcpServers;
        if (typeof local !== "object" || local === null) continue;
        for (const [name, server] of Object.entries(local as Record<string, unknown>)) {
          if (out.some((t) => t.name === name && t.scope === "local")) continue;
          out.push({
            name,
            scope: "local",
            summary: summarise(server),
            switchable: false,
            enabled: true,
            removeCommand: `claude mcp remove ${name}`,
          });
        }
        break;
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
