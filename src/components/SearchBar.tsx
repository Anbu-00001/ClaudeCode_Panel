import { Box, Text, useInput } from "ink";
import React from "react";

interface SearchBarProps {
  query: string;
  onQueryChange: (next: string) => void;
  active: boolean;
  onExit: () => void;
  placeholder?: string;
  resultCount: number;
}

/**
 * Type-to-filter, opened with `/` (§8.1). Deliberately not a text-input
 * library: we need Esc and Enter to mean "leave the box", not "submit a form",
 * and the arrow keys must keep belonging to the list underneath.
 */
export function SearchBar({
  query,
  onQueryChange,
  active,
  onExit,
  placeholder = "type to search",
  resultCount,
}: SearchBarProps) {
  useInput(
    (input, key) => {
      if (key.escape) {
        onQueryChange("");
        onExit();
        return;
      }
      if (key.return) {
        onExit(); // keep the filter, hand the arrows back to the list
        return;
      }
      if (key.backspace || key.delete) {
        onQueryChange(query.slice(0, -1));
        return;
      }
      // Ignore control characters and anything the list needs.
      if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab) return;
      if (input && input.length === 1 && input >= " ") onQueryChange(query + input);
    },
    { isActive: active },
  );

  const showing = query.length > 0 || active;
  if (!showing) return null;

  return (
    <Box>
      <Text color={active ? "cyan" : undefined}>
        {"  "}
        Search: {query.length > 0 ? query : <Text dimColor>{placeholder}</Text>}
        {active ? <Text color="cyan">▌</Text> : null}
      </Text>
      <Text dimColor>
        {"   "}
        {resultCount} {resultCount === 1 ? "match" : "matches"}
      </Text>
    </Box>
  );
}
