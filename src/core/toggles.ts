import { type RepoInfo, getClaudePaths } from "./paths.js";
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
 * Switches a .mcp.json server on or off via disabledMcpjsonServers. Only
 * project-scope servers can be switched this way; user-scope ones live in
 * ~/.claude.json and have no per-server switch (§5.5).
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
