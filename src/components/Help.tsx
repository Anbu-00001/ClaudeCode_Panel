import { Box, Text } from "ink";
import React from "react";

/**
 * The whole key vocabulary (§8.1). Shown on `?` from anywhere. No vim keys —
 * our reader doesn't know them and they'd clutter the footer.
 */
export function Help() {
  const keys: Array<[string, string]> = [
    ["↑ ↓", "move"],
    ["← →", "switch between the two lists"],
    ["Enter", "do the thing under the cursor"],
    ["Space", "flip a switch (on the Manage screen)"],
    ["/", "search this list"],
    ["u", "undo the last change"],
    ["?", "show or hide this"],
    ["Esc", "go back"],
    ["q", "quit"],
  ];

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Keys</Text>
      <Box marginTop={1} flexDirection="column">
        {keys.map(([key, what]) => (
          <Box key={key}>
            <Box width={9}>
              <Text bold>{key}</Text>
            </Box>
            <Text>{what}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Nothing here changes anything until you press Enter and read what it will do.
        </Text>
      </Box>
    </Box>
  );
}

/**
 * Shown once, the first time someone opens ccpanel in a folder with nothing
 * set up. It has one job: say what this is, in two sentences, and get out of
 * the way.
 */
export function FirstRun({ projectName }: { projectName: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>This shows what Claude Code can do that you aren't using yet.</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          Pick something below and press Enter. You'll see exactly what it will change before
          anything happens, and you can undo it afterwards.
        </Text>
        <Box marginTop={1}>
          <Text dimColor>
            Nothing here talks to an AI or spends your money. Everything on screen was read from
            files already in {projectName}.
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
