import { type RepoInfo, getClaudePaths } from "./paths.js";
import { projectConfigKey } from "./tools.js";
import { appendUndoEntry } from "./undo.js";
import type { SkillOverrideState } from "./validate.js";
import { type TransactionResult, runTransaction } from "./write.js";

/**
 * The four native switches (§5.3). Every one of these is a documented Claude
 * Code setting — we invent no mechanism, and every write goes through the
 * §12.1 protocol so a toggle is as safe and as reversible as an install.
 */

/**
 * Sets a skill's visibility. Written to settings.local.json, which is where
 * Claude Code's own /skills menu saves it, so the two agree.
 *
 * Setting a skill back to "on" removes the entry rather than writing "on":
 * a skill absent from skillOverrides is already treated as on, and leaving
 * dead entries behind makes the file harder for the user to read.
 */
export function setSkillState(
  repo: RepoInfo,
  skillName: string,
  state: SkillOverrideState,
): TransactionResult {
  const filePath = getClaudePaths(repo).localSettings;
  return runTransaction(
    [
      {
        kind: "patchJson",
        filePath,
        keyPath: ["skillOverrides", skillName],
        mutate: (draft) => {
          const current = (draft["skillOverrides"] as Record<string, unknown>) ?? {};
          const next = { ...current };
          if (state === "on") delete next[skillName];
          else next[skillName] = state;
          if (Object.keys(next).length > 0) draft["skillOverrides"] = next;
          else delete draft["skillOverrides"];
        },
      },
    ],
    { kind: "toggle", id: `skill:${skillName}`, label: `Changed "${skillName}" to ${state}` },
    appendUndoEntry,
  );
}

/**
 * Switches a .mcp.json server on or off via disabledMcpjsonServers. This is
 * the project-scope switch: it only covers servers a .mcp.json defined, but it
 * lives in the project, so a team can share it. For servers from any other
 * scope, use setServerDenied below.
 */
export function setToolEnabled(
  repo: RepoInfo,
  serverName: string,
  enabled: boolean,
): TransactionResult {
  const filePath = getClaudePaths(repo).localSettings;
  return runTransaction(
    [
      {
        kind: "patchJson",
        filePath,
        keyPath: ["disabledMcpjsonServers"],
        mutate: (draft) => {
          const current = Array.isArray(draft["disabledMcpjsonServers"])
            ? (draft["disabledMcpjsonServers"] as string[])
            : [];
          const next = enabled
            ? current.filter((n) => n !== serverName)
            : Array.from(new Set([...current, serverName]));
          if (next.length > 0) draft["disabledMcpjsonServers"] = next;
          else delete draft["disabledMcpjsonServers"];
        },
      },
    ],
    {
      kind: "toggle",
      id: `tool:${serverName}`,
      label: `Turned "${serverName}" ${enabled ? "on" : "off"}`,
    },
    appendUndoEntry,
  );
}

/**
 * Switches any server on or off for this folder, whatever scope defined it,
 * by name — including the user-scope ones that settings.json cannot reach.
 *
 * This writes `projects[<dir>].disabledMcpServers` in ~/.claude.json, which is
 * the same switch Claude Code's own /mcp menu writes; the two therefore agree
 * rather than fighting. Confirmed against the shipped Claude Code binary,
 * whose check is `(projectConfig.disabledMcpServers ?? []).includes(name)`.
 *
 * Two consequences worth knowing, both of them Claude Code's design and not
 * ours: the switch is per folder, so turning a server off here leaves it on
 * everywhere else; and it is a deny-list, so a server added later is on by
 * default.
 *
 * ~/.claude.json is Claude Code's own live state file, so this is the one
 * write that can collide with a running session. write.ts checks the file
 * hasn't moved under us and refuses rather than clobbering it.
 */
export function setServerDenied(
  repo: RepoInfo,
  serverName: string,
  enabled: boolean,
): TransactionResult {
  const filePath = getClaudePaths(repo).userClaudeJson;
  const key = projectConfigKey(repo);
  return runTransaction(
    [
      {
        kind: "patchJson",
        filePath,
        keyPath: ["projects", key, "disabledMcpServers"],
        mutate: (draft) => {
          const projects = (draft["projects"] as Record<string, unknown>) ?? {};
          const entry = (projects[key] as Record<string, unknown>) ?? {};
          const current = Array.isArray(entry["disabledMcpServers"])
            ? (entry["disabledMcpServers"] as string[])
            : [];
          const next = enabled
            ? current.filter((n) => n !== serverName)
            : Array.from(new Set([...current, serverName]));
          // An empty list is removed rather than left behind, so a folder the
          // user has switched everything back on in reads the same as one they
          // never touched.
          if (next.length > 0) entry["disabledMcpServers"] = next;
          else delete entry["disabledMcpServers"];
          projects[key] = entry;
          draft["projects"] = projects;
        },
      },
    ],
    {
      kind: "toggle",
      id: `tool:${serverName}`,
      label: `Turned "${serverName}" ${enabled ? "on" : "off"} for this folder`,
    },
    appendUndoEntry,
  );
}

/** All claude.ai connectors share one switch — there is no per-connector one. */
export function setConnectorsEnabled(repo: RepoInfo, enabled: boolean): TransactionResult {
  const filePath = getClaudePaths(repo).localSettings;
  return runTransaction(
    [
      {
        kind: "patchJson",
        filePath,
        keyPath: ["disableClaudeAiConnectors"],
        mutate: (draft) => {
          if (enabled) delete draft["disableClaudeAiConnectors"];
          else draft["disableClaudeAiConnectors"] = true;
        },
      },
    ],
    {
      kind: "toggle",
      id: "connectors",
      label: `Turned tools from claude.ai ${enabled ? "on" : "off"}`,
    },
    appendUndoEntry,
  );
}
