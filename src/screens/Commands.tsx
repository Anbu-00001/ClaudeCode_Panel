import { Box, Text, useInput } from "ink";
import React, { useEffect, useMemo, useState } from "react";
import { Footer, type FooterHint } from "../components/Footer.js";
import { List, type ListItem } from "../components/List.js";
import { SearchBar } from "../components/SearchBar.js";
import { type CommandEntry, loadCommands, searchCommands } from "../core/commands.js";

interface CommandsProps {
  onBack: () => void;
}

/**
 * The searchable command library (§10.4). Every command Claude Code ships,
 * described in plain language, with a mandatory warning before any that spends
 * money.
 */
export function Commands({ onBack }: CommandsProps) {
  const library = useMemo(() => loadCommands(), []);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [confirming, setConfirming] = useState<CommandEntry | null>(null);

  const results = useMemo(() => searchCommands(library, query), [library, query]);

  // A shrinking result list must never leave the cursor past the end.
  useEffect(() => {
    if (selectedIndex >= results.length) setSelectedIndex(Math.max(0, results.length - 1));
  }, [results.length, selectedIndex]);

  const current = results[selectedIndex];

  useInput((input, key) => {
    if (confirming) {
      if (key.escape) setConfirming(null);
      return;
    }
    if (searching) return; // the search box owns the keyboard
    if (input === "/") {
      setSearching(true);
      return;
    }
    if (key.escape) {
      if (query) {
        setQuery("");
        return;
      }
      onBack();
      return;
    }
    if (input === "q") onBack();
  });

  if (confirming) {
    return (
      <Box flexDirection="column">
        <Box borderStyle="single" paddingX={1}>
          <Text bold>{confirming.name}</Text>
        </Box>
        <Box flexDirection="column" paddingX={1} paddingY={1}>
          <Text>{confirming.plain}</Text>
          {confirming.why ? <Text dimColor>{confirming.why}</Text> : null}

          <Box marginTop={1}>
            {confirming.costsTokens ? (
              <Text color="yellow">This runs in Claude Code and costs money.</Text>
            ) : (
              <Text dimColor>This runs in Claude Code.</Text>
            )}
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text dimColor>Type it yourself in Claude Code:</Text>
            <Text bold>
              {confirming.name}
              {confirming.args ? ` ${confirming.args}` : ""}
            </Text>
          </Box>
        </Box>
        <Footer hints={[{ key: "Esc", label: "back" }]} />
      </Box>
    );
  }

  const items: ListItem[] = results.map((cmd) => {
    const item: ListItem = { key: cmd.name, label: cmd.name, sublabel: cmd.plain };
    if (cmd.removed) item.badge = "no longer works";
    else if (cmd.costsTokens) item.badge = "costs money";
    return item;
  });

  const hints: FooterHint[] = searching
    ? [
        { key: "type", label: "to filter" },
        { key: "Enter", label: "keep filter" },
        { key: "Esc", label: "clear" },
      ]
    : [
        { key: "↑↓", label: "move" },
        { key: "Enter", label: "how to use it" },
        { key: "/", label: "search" },
        { key: "Esc", label: "back" },
      ];

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" paddingX={1}>
        <Text bold>Things you can type · {library.commands.length} of them</Text>
      </Box>

      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <SearchBar
          query={query}
          onQueryChange={setQuery}
          active={searching}
          onExit={() => setSearching(false)}
          resultCount={results.length}
          placeholder="try: money, review, undo"
        />

        <Box marginTop={query || searching ? 1 : 0}>
          {results.length === 0 ? (
            <Text>Nothing matches that. Press Esc to clear the search.</Text>
          ) : (
            <List
              items={items.slice(0, 12)}
              selectedIndex={Math.min(selectedIndex, 11)}
              onSelectedIndexChange={setSelectedIndex}
              onSubmit={(_item, index) => {
                const cmd = results[index];
                if (cmd) setConfirming(cmd);
              }}
              isFocused={!searching}
            />
          )}
        </Box>

        {results.length > 12 ? (
          <Box marginTop={1}>
            <Text dimColor>…and {results.length - 12} more. Press / to narrow it down.</Text>
          </Box>
        ) : null}

        {current && !searching ? (
          <Box marginTop={1} borderStyle="round" borderDimColor paddingX={1} flexDirection="column">
            <Text>{current.why ?? current.plain}</Text>
            <Box marginTop={1}>
              <Text dimColor>Part of: {current.category}</Text>
            </Box>
          </Box>
        ) : null}
      </Box>

      <Footer hints={hints} />
    </Box>
  );
}
