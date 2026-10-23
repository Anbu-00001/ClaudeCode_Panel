import { Box, Text } from "ink";

/**
 * The whole key vocabulary (§8.1). Shown on `?` from the home screen. No vim
 * keys — our reader doesn't know them and they'd clutter the footer.
 *
 * Every key listed here must do what it says on the screen it names: this
 * list once promised `u` for undo, when on the one screen that reads `u` it
 * starts an update.
 */
export function Help() {
  const everywhere: Array<[string, string]> = [
    ["↑ ↓", "move"],
    ["Enter", "do the thing under the cursor"],
    ["Esc", "go back"],
    ["q", "quit (here); go back (anywhere else)"],
    ["?", "show or hide this"],
  ];
  const someScreens: Array<[string, string]> = [
    ["← →", "Manage: switch between the two lists · Spending: change the time span"],
    ["Space", "Manage: flip a switch"],
    ["u", "Manage: update the highlighted skill (you see the command first)"],
    ["/", "Commands: search the list"],
  ];

  const rows = (keys: Array<[string, string]>) =>
    keys.map(([key, what]) => (
      <Box key={key}>
        <Box width={9} flexShrink={0}>
          <Text bold>{key}</Text>
        </Box>
        <Text>{what}</Text>
      </Box>
    ));

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Keys</Text>
      <Box marginTop={1} flexDirection="column">
        {rows(everywhere)}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>On some screens</Text>
        {rows(someScreens)}
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
          anything happens, and you can remove it again from the same screen.
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
