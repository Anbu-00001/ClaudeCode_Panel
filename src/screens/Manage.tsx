import { Box, Text, useInput } from "ink";
import fs from "node:fs";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Footer, type FooterHint } from "../components/Footer.js";
import { List, type ListItem } from "../components/List.js";
import { getClaudePaths, type RepoInfo } from "../core/paths.js";
import {
  STATE_LABEL,
  STATE_SUBLABEL,
  type SkillInfo,
  listSkills,
  nextState,
  stateOf,
} from "../core/skills.js";
import {
  setPluginEnabled,
  setServerDenied,
  setSkillState,
  setToolEnabled,
} from "../core/toggles.js";
import { SCOPE_HEADING, type ToolInfo, listTools } from "../core/tools.js";
import {
  type SkillUpdateCheck,
  defaultExec,
  listSkillUpdates,
} from "../core/updates.js";
import type { SkillOverrideState } from "../core/validate.js";
import type { TransactionResult } from "../core/write.js";
import { maskText } from "../core/mask.js";

interface ManageProps {
  repo: RepoInfo;
  onOpenKits: () => void;
  onBack: () => void;
}

type Section = "tools" | "abilities";

function readOverrides(repo: RepoInfo): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(getClaudePaths(repo).localSettings, "utf8"));
    const o = (parsed as { skillOverrides?: unknown })?.skillOverrides;
    return typeof o === "object" && o !== null ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Which plugins are switched on, merged across the settings files in Claude
 * Code's own precedence order (user, then project, then local).
 *
 * `enabledPlugins` is a map of `plugin@marketplace` to a boolean, not a list —
 * see the note on the schema in core/validate.ts. A plugin missing from the
 * map has never been switched either way, and Claude Code treats that as on.
 */
function readEnabledPlugins(repo: RepoInfo): Record<string, boolean> {
  const paths = getClaudePaths(repo);
  const merged: Record<string, boolean> = {};
  for (const file of [paths.userSettings, paths.projectSettings, paths.localSettings]) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      const entry = (parsed as { enabledPlugins?: unknown })?.enabledPlugins;
      if (typeof entry !== "object" || entry === null) continue;
      for (const [id, on] of Object.entries(entry as Record<string, unknown>)) {
        if (typeof on === "boolean") merged[id] = on;
      }
    } catch {
      // A missing or broken settings file just contributes nothing.
    }
  }
  return merged;
}

/**
 * A failed write says what actually went wrong where we know it. A conflict in
 * particular is worth naming: it means a running Claude Code rewrote the file,
 * the user's change was not applied, and trying again will usually work.
 */
function writeProblem(result: TransactionResult): string {
  const failure = result.failure;
  if (failure?.reason === "conflict") return failure.message;
  if (failure?.reason === "unparseable") {
    return "That file has a syntax error, so ccpanel left it alone. Fix the file first.";
  }
  return "That couldn't be saved, so nothing was changed.";
}

/**
 * The secondary screen: switches for what you already own (§10.5). Every
 * switch here is one Claude Code documents — nothing is invented, and anything
 * we cannot honestly switch says so rather than faking it (§5.5).
 */
export function Manage({ repo, onOpenKits, onBack }: ManageProps) {
  const [section, setSection] = useState<Section>("tools");
  const [index, setIndex] = useState(0);
  const [version, setVersion] = useState(0); // bumped to re-read after a write
  const [notice, setNotice] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  const tools = useMemo(() => listTools(repo), [repo, version]);
  const skills = useMemo(() => listSkills(repo), [repo, version]);
  const overrides = useMemo(() => readOverrides(repo), [repo, version]);
  const enabledPlugins = useMemo(() => readEnabledPlugins(repo), [repo, version]);
  // Only an explicit false is off; unlisted means never switched, so it's on.
  const pluginOff = useMemo(
    () => new Set(Object.entries(enabledPlugins).filter(([, on]) => !on).map(([id]) => id)),
    [enabledPlugins],
  );

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  /**
   * Freshness is worked out off the main thread: it stats files and runs
   * `--version` on tools, which is fast but not instant, and a list that
   * appears immediately and fills in beats one that waits (§10). Nothing here
   * touches the network — see core/updates.ts.
   */
  const [updates, setUpdates] = useState<Map<string, SkillUpdateCheck>>(new Map());
  useEffect(() => {
    let cancelled = false;
    void listSkillUpdates(skills).then((checks) => {
      if (!cancelled) setUpdates(new Map(checks.map((c) => [c.skill.filePath, c])));
    });
    return () => {
      cancelled = true;
    };
  }, [skills]);

  /** The update we've offered but not yet run — C5's preview before anything. */
  const [pending, setPending] = useState<SkillUpdateCheck | null>(null);
  const [running, setRunning] = useState(false);
  const [ran, setRan] = useState<string | null>(null);

  const currentTool: ToolInfo | undefined = section === "tools" ? tools[index] : undefined;
  const currentSkill: SkillInfo | undefined = section === "abilities" ? skills[index] : undefined;
  const currentState: SkillOverrideState = currentSkill
    ? stateOf(overrides, currentSkill.name)
    : "on";

  const toggle = useCallback(() => {
    setNotice(null);

    if (section === "tools" && currentTool) {
      // Two different switches, picked by where the server came from — see
      // ToolSwitch in core/tools.ts. Both are Claude Code's own.
      const result =
        currentTool.switch === "mcpjson"
          ? setToolEnabled(repo, currentTool.name, !currentTool.enabled)
          : setServerDenied(repo, currentTool.name, !currentTool.enabled);
      if (!result.ok) setNotice(writeProblem(result));
      else {
        // Servers switched off outside .mcp.json are off for this folder only,
        // which is Claude Code's rule, not ours — so say it rather than let
        // the user assume it applied everywhere.
        if (currentTool.switch === "projectDeny" && currentTool.enabled) {
          setNotice(`"${currentTool.name}" is off in this folder. It stays on everywhere else.`);
        }
        refresh();
      }
      return;
    }

    if (section === "abilities" && currentSkill) {
      // A skill from a plugin has no skillOverrides entry — the plugin owns
      // it, and `claude plugin enable|disable` is the switch. That turns the
      // whole plugin on or off, not this one skill, so say so plainly.
      if (currentSkill.pluginId) {
        const turningOn = pluginOff.has(currentSkill.pluginId);
        const result = setPluginEnabled(currentSkill.pluginId, turningOn);
        if (!result.ok) {
          setNotice(result.output || "That didn't work, so nothing was changed.");
          return;
        }
        setChanged(true);
        setNotice(
          `${currentSkill.pluginId} is now ${turningOn ? "on" : "off"}. That covers everything in the bundle, not just this one. Restart Claude Code for it to take effect.`,
        );
        refresh();
        return;
      }

      if (!currentSkill.switchable) {
        setNotice(
          `"${currentSkill.name}" is switched somewhere else. Type /plugin in Claude Code to manage it.`,
        );
        return;
      }
      const result = setSkillState(repo, currentSkill.name, nextState(currentState));
      if (!result.ok) setNotice(writeProblem(result));
      else {
        setChanged(true);
        refresh();
      }
    }
  }, [section, currentTool, currentSkill, currentState, repo, refresh]);

  const currentUpdate = currentSkill ? updates.get(currentSkill.filePath) : undefined;

  const runUpdate = useCallback(async (check: SkillUpdateCheck) => {
    const command = check.command;
    if (!command) return;
    setRunning(true);
    // argv as an array, never a shell line — a skill directory called
    // `; rm -rf ~` has to stay a directory name.
    const [file, ...args] = command.argv;
    const result = await defaultExec(file as string, args, { timeoutMs: 120_000 });
    setRunning(false);
    setPending(null);
    setRan(
      result.ok
        ? `Updated ${check.skill.name}.${command.needsRestart ? " Restart Claude Code to pick it up." : ""}`
        : // Show what actually came back. A failed update that claims success
          // is worse than no update button at all.
          (result.stderr || result.stdout || "That didn't work.").trim(),
    );
    refresh();
  }, [refresh]);

  useInput((input, key) => {
    // While a preview is up it owns the keyboard, so Space can't toggle
    // something underneath the confirmation the user is reading.
    if (pending) {
      if (running) return;
      if (key.escape || input === "n" || input === "q") {
        setPending(null);
        return;
      }
      if (key.return || input === "y") void runUpdate(pending);
      return;
    }

    if (key.escape || input === "q") {
      onBack();
      return;
    }
    if (key.leftArrow || key.rightArrow) {
      setSection((s) => (s === "tools" ? "abilities" : "tools"));
      setIndex(0);
      setNotice(null);
      setRan(null);
      return;
    }
    if (input === "u" && section === "abilities" && currentUpdate) {
      setRan(null);
      if (currentUpdate.command) setPending(currentUpdate);
      // No command is not a failure — it means we could not find an honest
      // way to update this one, and the detail says why.
      else setNotice(currentUpdate.detail);
      return;
    }
    if (input === " ") toggle();
  });

  if (tools.length === 0 && skills.length === 0) {
    return (
      <Box flexDirection="column">
        <Box borderStyle="single" paddingX={1}>
          <Text bold>What you have</Text>
        </Box>
        <Box flexDirection="column" paddingX={1} paddingY={1}>
          <Text>You haven't added any tools or abilities yet.</Text>
          <Box marginTop={1}>
            <Text dimColor>Press Enter to see what you can set up in one step.</Text>
          </Box>
        </Box>
        <Footer hints={[{ key: "Enter", label: "see what's available" }, { key: "Esc", label: "back" }]} />
      </Box>
    );
  }

  // C5: the exact command is on screen before anything runs.
  if (pending) {
    return (
      <Box flexDirection="column">
        <Box borderStyle="single" paddingX={1}>
          <Text bold>Update {pending.skill.name}</Text>
        </Box>
        <Box flexDirection="column" paddingX={1} paddingY={1}>
          <Text>{pending.detail}</Text>
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>This runs:</Text>
            <Text color="cyan">{pending.command?.display}</Text>
          </Box>
          {pending.command?.needsRestart ? (
            <Box marginTop={1}>
              <Text dimColor>
                Claude Code has to be restarted afterwards before it notices the change.
              </Text>
            </Box>
          ) : null}
          {running ? (
            <Box marginTop={1}>
              <Text color="yellow">Running…</Text>
            </Box>
          ) : null}
        </Box>
        <Footer
          hints={
            running
              ? [{ key: "", label: "working…" }]
              : [
                  { key: "Enter", label: "run it" },
                  { key: "Esc", label: "leave it alone" },
                ]
          }
        />
      </Box>
    );
  }

  const items: ListItem[] =
    section === "tools"
      ? tools.map((t) => {
          const item: ListItem = {
            key: `${t.scope}:${t.name}`,
            label: `${t.name}  ·  ${t.enabled ? "On" : "Off"}`,
            sublabel: `${SCOPE_HEADING[t.scope]} — ${maskText(t.summary).slice(0, 58)}`,
          };
          // Every server can be switched now, but where the switch applies
          // still differs, and that is the part a user gets wrong.
          if (t.switch === "projectDeny") item.badge = "↳ switches off in this folder only";
          return item;
        })
      : skills.map((s) => {
          // "Out of date" is the one thing worth interrupting a row for, so it
          // outranks the badge that explains where the switch lives.
          const behind = updates.get(s.filePath)?.status === "behind";

          // A plugin skill has one of two states, not the four an override
          // gives, because the plugin switch is the only one that reaches it.
          if (s.pluginId) {
            const on = !pluginOff.has(s.pluginId);
            return {
              key: `${s.pluginId}:${s.name}`,
              label: `${s.name}  ·  ${on ? "On" : "Off"}`,
              sublabel: `uses ${s.weight} of Claude's memory — from the ${s.pluginId} bundle`,
              badge: behind ? "↳ update available · press u" : "↳ switches the whole bundle",
            } satisfies ListItem;
          }
          const state = stateOf(overrides, s.name);
          const item: ListItem = {
            key: `${s.source}:${s.name}`,
            label: `${s.name}  ·  ${STATE_LABEL[state]}`,
            sublabel: `uses ${s.weight} of Claude's memory — ${STATE_SUBLABEL[state]}`,
          };
          if (behind) item.badge = "↳ update available · press u";
          else if (!s.switchable) item.badge = "↳ not switchable here";
          return item;
        });

  const canSwitch =
    section === "tools"
      ? (currentTool?.switchable ?? false)
      : (currentSkill?.switchable ?? false) || Boolean(currentSkill?.pluginId);

  const hints: FooterHint[] = [
    { key: "↑↓", label: "move" },
    { key: "←→", label: section === "tools" ? "abilities" : "tools" },
    ...(canSwitch
      ? [
          {
            key: "Space",
            label:
              section === "abilities"
                ? currentSkill?.pluginId
                  ? pluginOff.has(currentSkill.pluginId)
                    ? "turn bundle on"
                    : "turn bundle off"
                  : `→ ${STATE_LABEL[nextState(currentState)]}`
                : currentTool?.enabled
                  ? "turn off"
                  : "turn on",
          },
        ]
      : [{ key: "Space", label: "why not?" }]),
    ...(section === "abilities" && currentUpdate
      ? [{ key: "u", label: currentUpdate.status === "behind" ? "update it" : "check for update" }]
      : []),
    { key: "Esc", label: "back" },
  ];

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" paddingX={1}>
        <Text bold>What you have</Text>
        <Text dimColor>
          {"    "}
          <Text color={section === "tools" ? "cyan" : undefined}>Tools ({tools.length})</Text>
          {"   "}
          <Text color={section === "abilities" ? "cyan" : undefined}>
            Abilities ({skills.length})
          </Text>
        </Text>
      </Box>

      <Box flexDirection="column" paddingX={1} paddingY={1}>
        {items.length === 0 ? (
          <Text>Nothing here yet. Press ← or → to see the other list.</Text>
        ) : (
          <List items={items} selectedIndex={index} onSelectedIndexChange={setIndex} />
        )}

        {notice ? (
          <Box marginTop={1}>
            <Text color="yellow">{notice}</Text>
          </Box>
        ) : null}

        {ran ? (
          <Box marginTop={1}>
            <Text color="green">{ran}</Text>
          </Box>
        ) : null}

        {/* Freshness for the highlighted ability. "Can't tell" is shown as
            itself rather than rounded up to "up to date" (see updates.ts). */}
        {section === "abilities" && currentUpdate && !notice && !ran ? (
          <Box marginTop={1}>
            <Text dimColor>{currentUpdate.summary}</Text>
          </Box>
        ) : null}

        {section === "abilities" && currentSkill?.disablesModelInvocation ? (
          <Box marginTop={1}>
            <Text dimColor>
              This one already only runs when you ask for it, whatever you set here.
            </Text>
          </Box>
        ) : null}

        {/* Older Claude Code versions accepted this setting and then ignored
            it. We can't tell from here which versions honour it, so we tell
            the user how to check rather than promising it worked. */}
        {section === "abilities" && changed ? (
          <Box marginTop={1}>
            <Text dimColor>
              Saved. Type /skills in Claude Code to check it took effect — on some older versions
              this setting was ignored.
            </Text>
          </Box>
        ) : null}
      </Box>

      <Footer hints={hints} />
    </Box>
  );
}
