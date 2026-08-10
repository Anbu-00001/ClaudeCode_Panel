import { execFileSync } from "node:child_process";
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

/**
 * Runs one Claude Code CLI subcommand. Never a prompt — these are the same
 * management subcommands a user could type, so nothing here reaches a model
 * or costs anything (C1, C2).
 */
export type CommandRunner = (file: string, args: string[]) => { ok: boolean; output: string };

const runCommand: CommandRunner = (file, args) => {
  try {
    const output = execFileSync(file, args, {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: output.trim() };
  } catch (err) {
    // A missing `claude` binary and a subcommand that failed are both just
    // "it didn't work" to the caller, but the message differs and the user
    // needs to see which — so pass through whatever we actually got.
    const e = err as { stderr?: string; stdout?: string; message?: string; code?: string };
    const detail = [e.stderr, e.stdout, e.message].find((s) => typeof s === "string" && s.trim());
    return {
      ok: false,
      output:
        e.code === "ENOENT"
          ? "Couldn't find the `claude` command on this computer."
          : (detail ?? "").trim(),
    };
  }
};

/**
 * Switches a plugin — and so every skill inside it — on or off.
 *
 * Skills that come from a plugin have no entry in skillOverrides; `/plugin`
 * owns them, and its CLI is `claude plugin enable|disable <plugin>`, verified
 * against the installed Claude Code. The scope flag is deliberately omitted:
 * it defaults to auto-detect, and letting Claude Code find the plugin is more
 * reliable than us guessing which scope installed it.
 */
export function setPluginEnabled(
  pluginId: string,
  enabled: boolean,
  run: CommandRunner = runCommand,
): { ok: boolean; output: string } {
  return run("claude", ["plugin", enabled ? "enable" : "disable", pluginId]);
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
