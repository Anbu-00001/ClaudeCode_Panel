import { Box, Text, useApp, useInput } from "ink";
import path from "node:path";
import React, { useMemo, useState } from "react";
import { Footer, type FooterHint } from "../components/Footer.js";
import { List, type ListItem } from "../components/List.js";
import { RUNG_LABELS, RUNG_ORDER, type LadderState } from "../core/detect.js";
import { KIT_TITLES } from "../data/kit-titles.js";

interface LadderProps {
  state: LadderState;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function Ladder({ state }: LadderProps) {
  const { exit } = useApp();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const projectName = path.basename(state.repo.projectDir);
  const startFromScratch = state.countOn === 0;

  const suggestions = useMemo(() => {
    const unfulfilled = KIT_TITLES.filter((k) => !state.rungs[k.rung]);
    return startFromScratch ? unfulfilled.slice(0, 1) : unfulfilled.slice(0, 3);
  }, [state, startFromScratch]);

  const items: ListItem[] = useMemo(() => {
    const kitItems: ListItem[] = suggestions.map((k) => ({ key: k.id, label: k.title }));
    const navItems: ListItem[] = [
      { key: "explore", label: "Explore everything →" },
      { key: "manage", label: "Manage what you have →" },
      { key: "spending", label: "Spending →" },
    ];
    return [...kitItems, ...navItems];
  }, [suggestions]);

  useInput((input, key) => {
    if (input === "?") {
      setShowHelp((v) => !v);
      return;
    }
    if (key.escape) {
      setShowHelp(false);
      setNotice(null);
      return;
    }
    if (input === "q") {
      exit();
    }
  });

  function handleSubmit(item: ListItem) {
    setNotice(`"${item.label}" is coming in a later milestone — this build only shows where you stand.`);
  }

  const footerHints: FooterHint[] = [
    { key: "↑↓", label: "move" },
    { key: "Enter", label: "open" },
    { key: "?", label: "help" },
    { key: "q", label: "quit" },
  ];

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" paddingX={1}>
        <Text bold>ccpanel · {projectName}</Text>
      </Box>

      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text>
          You're using <Text bold>{state.countOn}</Text> of {state.countTotal} things Claude Code
          can do.
        </Text>

        <Box marginTop={1} flexDirection="column">
          {chunk(RUNG_ORDER, 3).map((row) => (
            <Box key={row.join(",")}>
              {row.map((rung) => (
                <Box key={rung} width={27}>
                  <Text color={state.rungs[rung] ? "green" : undefined} dimColor={!state.rungs[rung]}>
                    {state.rungs[rung] ? "✓ " : "· "}
                    {RUNG_LABELS[rung]}
                  </Text>
                </Box>
              ))}
            </Box>
          ))}
        </Box>

        {showHelp ? (
          <Box marginTop={1} flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold>Keys</Text>
            <Text>↑ ↓ move</Text>
            <Text>Enter do the thing under the cursor</Text>
            <Text>? toggle this help</Text>
            <Text>Esc close this</Text>
            <Text>q quit</Text>
          </Box>
        ) : (
          <>
            <Box marginTop={1}>
              <Text bold>
                {startFromScratch ? "Start here — it takes about a minute." : "Set up in one step"}
              </Text>
            </Box>

            <Box marginTop={1}>
              <List
                items={items}
                selectedIndex={selectedIndex}
                onSelectedIndexChange={setSelectedIndex}
                onSubmit={handleSubmit}
                isFocused={!showHelp}
              />
            </Box>

            {notice ? (
              <Box marginTop={1}>
                <Text color="yellow">{notice}</Text>
              </Box>
            ) : null}
          </>
        )}
      </Box>

      <Footer hints={footerHints} />
    </Box>
  );
}
