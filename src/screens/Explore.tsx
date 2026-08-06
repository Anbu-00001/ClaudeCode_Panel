import { Box, Text, useInput } from "ink";
import React, { useMemo, useState } from "react";
import { Footer, type FooterHint } from "../components/Footer.js";
import { List, type ListItem } from "../components/List.js";
import { type ExplainEntry, loadExplain } from "../core/explain.js";
import { type Kit, isKitInstalled } from "../core/kits.js";
import type { RepoInfo } from "../core/paths.js";

interface ExploreProps {
  kits: Kit[];
  repo: RepoInfo;
  onOpenKit: (kit: Kit) => void;
  onBack: () => void;
}

/**
 * The teaching screen (§10.3). One entry per capability: what it is, when you
 * would want it, one concrete example, and a way to set it up if a kit
 * provides it.
 */
export function Explore({ kits, repo, onOpenKit, onBack }: ExploreProps) {
  const entries = useMemo(() => loadExplain(), []);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const current: ExplainEntry | undefined = entries[selectedIndex];

  const kitFor = (entry: ExplainEntry | undefined): Kit | undefined =>
    entry?.kitId ? kits.find((k) => k.id === entry.kitId) : undefined;

  const currentKit = kitFor(current);
  const alreadyHave = currentKit ? isKitInstalled(currentKit, repo) : false;

  useInput((input, key) => {
    if (key.escape || input === "q") onBack();
    if (key.return && currentKit && !alreadyHave) onOpenKit(currentKit);
  });

  const items: ListItem[] = entries.map((e) => {
    const kit = kitFor(e);
    const item: ListItem = { key: e.id, label: `${e.plainName}  —  ${e.oneLine}` };
    if (kit && isKitInstalled(kit, repo)) item.badge = "✓ you have this";
    else if (kit) item.badge = "can be set up";
    return item;
  });

  const hints: FooterHint[] = [
    { key: "↑↓", label: "move" },
    ...(currentKit && !alreadyHave ? [{ key: "Enter", label: "set it up" }] : []),
    { key: "Esc", label: "back" },
  ];

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" paddingX={1}>
        <Text bold>What Claude Code can do</Text>
      </Box>

      <Box flexDirection="column" paddingX={1} paddingY={1}>
        {/* Single column with the detail underneath. A two-column split looked
            tidier in a mockup, but the descriptions wrap at this width and the
            two sides collide. */}
        <List
          items={items}
          selectedIndex={selectedIndex}
          onSelectedIndexChange={setSelectedIndex}
        />

        {current ? (
          <Box marginTop={1} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
            <Text bold>{current.plainName}</Text>
            <Box marginTop={1}>
              <Text>{current.whatItIs}</Text>
            </Box>
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>When you'd want it</Text>
              <Text>{current.whenYouWantIt}</Text>
            </Box>
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>For example</Text>
              <Text>{current.example}</Text>
            </Box>
            {currentKit ? (
              <Box marginTop={1}>
                <Text color={alreadyHave ? "green" : "cyan"}>
                  {alreadyHave ? "✓ You already have this set up." : "→ Press Enter to set this up."}
                </Text>
              </Box>
            ) : null}
          </Box>
        ) : null}
      </Box>

      <Footer hints={hints} />
    </Box>
  );
}
