#!/usr/bin/env node
import { render } from "ink";
import { App } from "./app.js";
import {
  HELP_TEXT,
  notATerminalMessage,
  parseLaunchArgs,
  readVersion,
  sizeProblem,
} from "./core/launch.js";
import { resolvePaths } from "./core/paths.js";
import { sweepConfigTempFiles } from "./core/write.js";

const action = parseLaunchArgs(process.argv.slice(2));
if (action.kind === "help") {
  process.stdout.write(HELP_TEXT);
  process.exit(0);
}
if (action.kind === "version") {
  process.stdout.write(`${readVersion()}\n`);
  process.exit(0);
}
if (action.kind === "unknown") {
  process.stderr.write(`ccpanel doesn't know "${action.arg}".\n\n${HELP_TEXT}`);
  process.exit(1);
}

const notTerminal = notATerminalMessage(
  Boolean(process.stdin.isTTY),
  Boolean(process.stdout.isTTY),
);
if (notTerminal) {
  process.stderr.write(notTerminal);
  process.exit(1);
}

// Pre-flight check avoids paying for an Ink render (alt-screen, raw mode)
// when we already know the terminal can't fit the UI.
const tooSmall = sizeProblem(process.stdout.columns ?? 80, process.stdout.rows ?? 24);
if (tooSmall) {
  process.stdout.write(`${tooSmall}\n`);
  process.exit(0);
}

// A ccpanel killed mid-write leaves a hidden temp file next to the config it
// was writing. Clear old ones away before starting; never a reason not to start.
try {
  sweepConfigTempFiles(resolvePaths());
} catch {
  /* best effort */
}

const { waitUntilExit } = render(<App />);

waitUntilExit().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
