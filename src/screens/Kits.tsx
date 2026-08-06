import { Box, Text, useInput } from "ink";
import React, { useMemo, useState } from "react";
import { Footer, type FooterHint } from "../components/Footer.js";
import { List, type ListItem } from "../components/List.js";
import { RUNG_LABELS } from "../core/detect.js";
import { type Kit, isKitInstalled } from "../core/kits.js";
import type { RepoInfo } from "../core/paths.js";

interface KitsProps {
  kits: Kit[];
  repo: RepoInfo;
  onOpen: (kit: Kit) => void;
  onBack: () => void;
}

/**
 * The kit list. Arrow keys move; the description of whatever is under the
 * cursor is shown below the list, so the user reads about a thing by
 * arrowing onto it rather than opening it first.
 */
export function Kits({ kits, repo, onOpen, onBack }: KitsProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const installed = useMemo(
    () => new Map(kits.map((k) => [k.id, isKitInstalled(k, repo)])),
    [kits, repo],
  );

  const items: ListItem[] = useMemo(
    () =>
      kits.map((kit) => {
        const item: ListItem = { key: kit.id, label: kit.title };
        if (installed.get(kit.id)) item.badge = "✓ already set up";
        return item;
      }),
    [kits, installed],
  );

  const current = kits[selectedIndex];

  useInput((input, key) => {
    if (key.escape || input === "q") onBack();
  });

  const hints: FooterHint[] = [
    { key: "↑↓", label: "move" },
    { key: "Enter", label: current && installed.get(current.id) ? "remove it" : "set it up" },
    { key: "Esc", label: "back" },
  ];

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" paddingX={1}>
        <Text bold>Set up in one step</Text>
      </Box>

      <Box flexDirection="column" paddingX={1} paddingY={1}>
        {kits.length === 0 ? (
          <Text>There are no kits available.</Text>
        ) : (
          <>
            <List
              items={items}
              selectedIndex={selectedIndex}
              onSelectedIndexChange={setSelectedIndex}
              onSubmit={(_item, index) => {
                const kit = kits[index];
                if (kit) onOpen(kit);
              }}
            />

            {current ? (
              <Box
                flexDirection="column"
                marginTop={1}
                borderStyle="round"
                borderDimColor
                paddingX={1}
              >
                {current.newcomerProblem ? (
                  <Box marginBottom={1}>
                    <Text color="cyan">When this helps: {current.newcomerProblem}</Text>
                  </Box>
                ) : null}
                <Text>{current.blurb}</Text>
                {current.honestLimit ? (
                  <Box marginTop={1}>
                    <Text dimColor>{current.honestLimit}</Text>
                  </Box>
                ) : null}
                <Box marginTop={1}>
                  <Text dimColor>Part of: {RUNG_LABELS[current.rung] ?? current.rung}</Text>
                </Box>
              </Box>
            ) : null}
          </>
        )}
      </Box>

      <Footer hints={hints} />
    </Box>
  );
}
