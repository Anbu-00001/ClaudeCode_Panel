import { Box, Text, useInput } from "ink";
import React from "react";

export interface ListItem {
  key: string;
  label: string;
  sublabel?: string;
  badge?: string;
  disabled?: boolean;
}

interface ListProps {
  items: ListItem[];
  selectedIndex: number;
  onSelectedIndexChange: (index: number) => void;
  onSubmit?: (item: ListItem, index: number) => void;
  isFocused?: boolean;
}

function nextEnabledIndex(items: ListItem[], from: number, direction: 1 | -1): number {
  if (items.length === 0) return from;
  let i = from;
  for (let step = 0; step < items.length; step++) {
    i = (i + direction + items.length) % items.length;
    if (!items[i]?.disabled) return i;
  }
  return from;
}

/** The one list component: every screen with a navigable list uses this. */
export function List({
  items,
  selectedIndex,
  onSelectedIndexChange,
  onSubmit,
  isFocused = true,
}: ListProps) {
  useInput(
    (_input, key) => {
      if (items.length === 0) return;
      if (key.upArrow) {
        onSelectedIndexChange(nextEnabledIndex(items, selectedIndex, -1));
      } else if (key.downArrow) {
        onSelectedIndexChange(nextEnabledIndex(items, selectedIndex, 1));
      } else if (key.return) {
        const item = items[selectedIndex];
        if (item && !item.disabled) onSubmit?.(item, selectedIndex);
      }
    },
    { isActive: isFocused },
  );

  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        const active = isFocused && i === selectedIndex;
        return (
          <Box key={item.key} flexDirection="column">
            <Text color={active ? "cyan" : undefined} dimColor={item.disabled}>
              {active ? "→ " : "  "}
              {item.label}
              {item.badge ? `   [ ${item.badge} ]` : ""}
            </Text>
            {item.sublabel ? (
              <Text dimColor>
                {"    "}
                {item.sublabel}
              </Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}
