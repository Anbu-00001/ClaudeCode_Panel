import { Box, Text, useInput } from "ink";
import fs from "node:fs";
import React, { useCallback, useMemo, useState } from "react";
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
import { setServerDenied, setSkillState, setToolEnabled } from "../core/toggles.js";
import { SCOPE_HEADING, type ToolInfo, listTools } from "../core/tools.js";
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

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

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
      if (!currentSkill.switchable) {
        setNotice(
          `"${currentSkill.name}" came from a bundle, so it's switched somewhere else. Type /plugin in Claude Code to manage it.`,
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

  useInput((input, key) => {
    if (key.escape || input === "q") {
      onBack();
      return;
    }
    if (key.leftArrow || key.rightArrow) {
      setSection((s) => (s === "tools" ? "abilities" : "tools"));
      setIndex(0);
      setNotice(null);
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
          const state = stateOf(overrides, s.name);
          const item: ListItem = {
            key: `${s.pluginId ?? s.source}:${s.name}`,
            label: `${s.name}  ·  ${STATE_LABEL[state]}`,
            sublabel: `uses ${s.weight} of Claude's memory — ${STATE_SUBLABEL[state]}`,
          };
          if (!s.switchable) item.badge = "↳ part of a bundle · not switchable here";
          return item;
        });

  const canSwitch =
    section === "tools" ? (currentTool?.switchable ?? false) : (currentSkill?.switchable ?? false);

  const hints: FooterHint[] = [
    { key: "↑↓", label: "move" },
    { key: "←→", label: section === "tools" ? "abilities" : "tools" },
    ...(canSwitch
      ? [
          {
            key: "Space",
            label:
              section === "abilities"
                ? `→ ${STATE_LABEL[nextState(currentState)]}`
                : currentTool?.enabled
                  ? "turn off"
                  : "turn on",
          },
        ]
      : [{ key: "Space", label: "why not?" }]),
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
