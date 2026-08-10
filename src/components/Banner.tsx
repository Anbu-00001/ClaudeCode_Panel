import { Box, Text } from "ink";
import { createRequire } from "node:module";
import React from "react";

const require = createRequire(import.meta.url);

/**
 * The version is read from package.json at runtime, the same way the command
 * library is loaded in src/core/commands.ts. Copying the number into the
 * source would let a release ship a banner that lies about which ccpanel this
 * is — the one fact a bug report needs to be worth anything.
 */
export function ccpanelVersion(): string {
  const pkg = require("../../package.json") as { version?: string };
  return pkg.version ?? "unknown";
}

/**
 * Hand-drawn, not generated: seven letters aren't worth a dependency, and a
 * font package would make the greeting differ between machines.
 *
 * Every line below is 45 printed columns wide. A `\\` in this source is one
 * column on screen, so don't trust how the block lines up in an editor —
 * WORDMARK_WIDTH is measured from the strings, never assumed.
 */
export const WORDMARK_LINES = [
  "                                           _",
  "  ___    ___   _ __    __ _  _ __    ___  | |",
  " / __|  / __| | '_ \\  / _` || '_ \\  / _ \\ | |",
  "| (__  | (__  | |_) || (_| || | | ||  __/ | |",
  " \\___|  \\___| | .__/  \\__,_||_| |_| \\___| |_|",
  "              |_|",
];

const WORDMARK_WIDTH = Math.max(...WORDMARK_LINES.map((line) => line.length));

/** The README's opening sentence, shortened to one line. */
const TAGLINE = "What Claude Code can do that you aren't using yet.";

/** paddingX={1} on both sides, so the banner lines up with a screen's body. */
const PADDING = 2;

/**
 * src/cli.tsx refuses to start below 80x24, so 24 rows is the smallest window
 * any screen ever gets — and the ladder already uses all of it. The banner is
 * decoration, so it only appears when the window has rows to spare *on top of*
 * that floor: 8 for the full art (6 lines, the tagline, and a blank line), 2
 * for the one-line version. Anything shorter shows nothing at all, because a
 * greeting that scrolls the footer out of sight costs more than it gives.
 */
const SCREEN_FLOOR_ROWS = 24;
const FULL_MIN_ROWS = SCREEN_FLOOR_ROWS + WORDMARK_LINES.length + 2;
const COMPACT_MIN_ROWS = SCREEN_FLOOR_ROWS + 2;

/**
 * https://no-color.org — any NO_COLOR that is set and non-empty means no
 * colour, whatever its value. Colour is only ever an accent here: the wordmark
 * reads identically without it, which is also what a terminal Ink knows can't
 * do colour gets, since Ink drops the codes on its own.
 */
export function accentColor(env: NodeJS.ProcessEnv = process.env): "cyan" | undefined {
  const noColor = env["NO_COLOR"];
  if (noColor !== undefined && noColor !== "") return undefined;
  return "cyan";
}

export interface BannerProps {
  /**
   * Default to the real terminal. App passes these in so a resize re-renders
   * the banner instead of leaving a stale one on screen.
   */
  columns?: number;
  rows?: number;
}

export function Banner({
  columns = process.stdout.columns ?? 80,
  rows = process.stdout.rows ?? 24,
}: BannerProps) {
  const version = ccpanelVersion();
  const color = accentColor();

  const taglineLine = `${TAGLINE}  ·  v${version}`;
  const compactLine = `ccpanel v${version}`;

  // Measured against the real strings, so a longer version number can't quietly
  // start wrapping the tagline under the art.
  const fullWidth = Math.max(WORDMARK_WIDTH, taglineLine.length) + PADDING;
  const compactWidth = compactLine.length + PADDING;

  if (columns >= fullWidth && rows >= FULL_MIN_ROWS) {
    return (
      <Box flexDirection="column" paddingX={1} marginBottom={1}>
        {WORDMARK_LINES.map((line, i) => (
          // The art is fixed, so the index is a stable identity here.
          <Text key={i} color={color}>
            {line}
          </Text>
        ))}
        <Text dimColor>{taglineLine}</Text>
      </Box>
    );
  }

  if (columns >= compactWidth && rows >= COMPACT_MIN_ROWS) {
    return (
      <Box paddingX={1} marginBottom={1}>
        <Text>
          <Text bold color={color}>
            ccpanel
          </Text>
          <Text dimColor> v{version}</Text>
        </Text>
      </Box>
    );
  }

  return null;
}
