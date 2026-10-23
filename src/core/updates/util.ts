import fs from "node:fs";
import type { UpdateCommand } from "./types.js";

/** Small helpers shared by the update checkers. Part of core/updates.ts — see the overview there. */

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

export function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null; // missing or broken is just "no information"
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** "3 days ago" beats an ISO timestamp for someone deciding whether to care. */
export function describeAge(from: Date, now: Date): string {
  const ms = now.getTime() - from.getTime();
  if (ms < 0) return "just now";
  if (ms < MINUTE) return "moments ago";
  if (ms < HOUR) {
    const n = Math.max(1, Math.round(ms / MINUTE));
    return `${n} minute${n === 1 ? "" : "s"} ago`;
  }
  if (ms < DAY) {
    const n = Math.max(1, Math.round(ms / HOUR));
    return `${n} hour${n === 1 ? "" : "s"} ago`;
  }
  const n = Math.max(1, Math.round(ms / DAY));
  return `${n} day${n === 1 ? "" : "s"} ago`;
}

export function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function makeCommand(
  argv: string[],
  needsRestart: boolean,
  env?: Record<string, string>,
): UpdateCommand {
  return { argv, display: argv.join(" "), needsRestart, ...(env ? { env } : {}) };
}

export function statOrNull(target: string): fs.Stats | null {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}
