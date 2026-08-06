import { Box, Text } from "ink";
import React from "react";

export interface FooterHint {
  key: string;
  label: string;
}

/** Footer shows only the keys valid right now — never a static list. */
export function Footer({ hints }: { hints: FooterHint[] }) {
  return (
    <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} paddingX={1}>
      <Text dimColor>
        {hints.map((h) => `${h.key} ${h.label}`).join("  ·  ")}
      </Text>
    </Box>
  );
}
