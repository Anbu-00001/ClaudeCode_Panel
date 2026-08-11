import { Box, Text, useInput } from "ink";
import React from "react";

export interface ListItem {
  key: string;
  label: string;
  sublabel?: string;
  badge?: string;
  disabled?: boolean;
  /**
   * A switch or button drawn to the left of the label, for rows that *do*
   * something rather than just navigate. Rows read as inert when their state
   * is only words, so anything togglable gets a control the eye can find.
   * The list pads every control to a common width so labels line up.
   */
  control?: { text: string; color?: string };
  /** A second control on the right, e.g. an action available on this row. */
  action?: { text: string; color?: string };
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

  // One width for every control, so the labels form a straight edge instead of
  // stepping in and out with each row's state.
  const controlWidth = Math.max(0, ...items.map((i) => i.control?.text.length ?? 0));
  const labelWidth = Math.max(0, ...items.map((i) => i.label.length));

  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        const active = isFocused && i === selectedIndex;
        return (
          <Box key={item.key} flexDirection="column">
            <Text dimColor={item.disabled}>
              <Text color={active ? "cyan" : undefined}>{active ? "→ " : "  "}</Text>
              {item.control ? (
                <Text color={item.control.color} bold={active}>
                  {item.control.text.padEnd(controlWidth)}{"  "}
                </Text>
              ) : null}
              <Text color={active ? "cyan" : undefined}>
                {item.action ? item.label.padEnd(labelWidth) : item.label}
              </Text>
              {item.action ? (
                <Text color={item.action.color} bold={active}>
                  {"   "}
                  {item.action.text}
                </Text>
              ) : null}
              {item.badge ? <Text dimColor>{`   [ ${item.badge} ]`}</Text> : null}
            </Text>
            {item.sublabel ? (
              <Text dimColor>
                {"    "}
                {controlWidth > 0 ? " ".repeat(controlWidth + 2) : ""}
                {item.sublabel}
              </Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}
