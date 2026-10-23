import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Everything decided before the screen opens: flags, whether this is a real
 * terminal, and whether the window is big enough. Kept apart from cli.tsx so
 * it can be tested without starting Ink.
 */

export const MIN_COLUMNS = 80;
export const MIN_ROWS = 24;

export type LaunchAction =
  | { kind: "run" }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "unknown"; arg: string };

export function parseLaunchArgs(argv: readonly string[]): LaunchAction {
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h" || arg === "help") return { kind: "help" };
    if (arg === "--version" || arg === "-v" || arg === "-V") return { kind: "version" };
    return { kind: "unknown", arg };
  }
  return { kind: "run" };
}

export const HELP_TEXT = `ccpanel: discover what Claude Code can do that you aren't using yet.

Usage:
  ccpanel            open the panel for the folder you're in
  ccpanel --help     show this
  ccpanel --version  show which version this is

It opens a full-screen view, so it needs a terminal window of at least
${MIN_COLUMNS} columns by ${MIN_ROWS} rows.
`;

/** The version in ccpanel's own package.json (src/core and dist/core are both two levels down). */
export function readVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Ink needs to read keys one at a time, which only a terminal allows. Piped
 * in or out, it would crash with a raw-mode stack trace instead.
 */
export function notATerminalMessage(stdinIsTTY: boolean, stdoutIsTTY: boolean): string | null {
  if (stdinIsTTY && stdoutIsTTY) return null;
  return "ccpanel is an interactive screen, so it has to run directly in a terminal window. Its input or output is being piped or redirected here. Run `ccpanel --help` to see what it can do.\n";
}

/** Says both limits, and which one this window misses, or null when it fits. */
export function sizeProblem(columns: number, rows: number): string | null {
  const narrow = columns < MIN_COLUMNS;
  const short = rows < MIN_ROWS;
  if (!narrow && !short) return null;
  const misses = [
    narrow ? `${columns} columns wide` : null,
    short ? `${rows} rows tall` : null,
  ].filter(Boolean);
  return `ccpanel needs a window at least ${MIN_COLUMNS} columns wide and ${MIN_ROWS} rows tall. This one is ${misses.join(" and ")}, so make it ${narrow && short ? "wider and taller" : narrow ? "wider" : "taller"}.`;
}
