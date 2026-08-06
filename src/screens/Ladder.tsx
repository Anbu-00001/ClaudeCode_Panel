import { Box, Text, useApp, useInput } from "ink";
import path from "node:path";
import React, { useMemo, useState } from "react";
import { Footer, type FooterHint } from "../components/Footer.js";
import { List, type ListItem } from "../components/List.js";
import { RUNG_LABELS, RUNG_ORDER, type LadderState } from "../core/detect.js";
import { type Kit, isKitInstalled } from "../core/kits.js";

interface LadderProps {
  state: LadderState;
  kits: Kit[];
  onOpenKits: () => void;
  onOpenKit?: (kit: Kit) => void;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function Ladder({ state, kits, onOpenKits, onOpenKit }: LadderProps) {
  const { exit } = useApp();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const projectName = path.basename(state.repo.projectDir);
  const startFromScratch = state.countOn === 0;

  // Hand-curated order, not a score (§10.1): the kits file order is the
  // priority order, filtered to what this project doesn't already have.
  const suggestions = useMemo(() => {
    const available = kits.filter((k) => !isKitInstalled(k, state.repo));
    return startFromScratch ? available.slice(0, 1) : available.slice(0, 3);
  }, [kits, state.repo, startFromScratch]);

  const items: ListItem[] = useMemo(
    () => [
      ...suggestions.map((k) => ({ key: `kit:${k.id}`, label: k.title })),
      { key: "kits", label: "See everything you can set up →" },
      { key: "explore", label: "Explore everything →" },
      { key: "manage", label: "Manage what you have →" },
      { key: "spending", label: "Spending →" },
    ],
    [suggestions],
  );

  const highlighted = items[selectedIndex];
  const highlightedKit = highlighted?.key.startsWith("kit:")
    ? suggestions.find((k) => `kit:${k.id}` === highlighted.key)
    : undefined;

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
    if (input === "q") exit();
  });

  function handleSubmit(item: ListItem) {
    if (item.key === "kits") {
      onOpenKits();
      return;
    }
    if (item.key.startsWith("kit:")) {
      const kit = suggestions.find((k) => `kit:${k.id}` === item.key);
      if (kit && onOpenKit) onOpenKit(kit);
      else onOpenKits();
      return;
    }
    setNotice(`"${item.label.replace(" →", "")}" is coming in a later milestone.`);
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

            {/* What's under the cursor, explained without opening it. */}
            {highlightedKit ? (
              <Box marginTop={1} borderStyle="round" borderDimColor paddingX={1}>
                <Text>{highlightedKit.blurb}</Text>
              </Box>
            ) : null}

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
