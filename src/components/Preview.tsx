import { Box, Text } from "ink";
import React from "react";
import type { KitPreview } from "../core/kits.js";

/**
 * The mandatory before-anything-happens view (C5). Every file that will be
 * created and every setting that will change, in plain language.
 */
export function Preview({ preview }: { preview: KitPreview }) {
  return (
    <Box flexDirection="column">
      <Text>This will:</Text>
      <Box flexDirection="column" marginTop={1}>
        {preview.lines.map((line) => (
          <Box key={`${line.op}-${line.displayPath}`} flexDirection="column">
            <Text>
              {"  "}
              <Text color={line.op === "create" ? "green" : "yellow"}>
                {line.op === "create" ? "+" : "~"}
              </Text>
              {"  "}
              {line.op === "create" ? "create" : line.op === "append" ? "add to" : "change"}
              {"   "}
              {line.displayPath}
              {line.conflict ? <Text color="red">  ← something else is already here</Text> : null}
            </Text>
            {line.note ? (
              <Text dimColor>
                {"            "}
                {line.note}
              </Text>
            ) : null}
          </Box>
        ))}
      </Box>

      {preview.warnings.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {preview.warnings.map((w) => (
            <Text key={w} color="red">
              {w}
            </Text>
          ))}
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>Nothing else on your computer is touched.</Text>
      </Box>
    </Box>
  );
}
