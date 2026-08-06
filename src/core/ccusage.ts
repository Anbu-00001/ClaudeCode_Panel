import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Spending, read from files already on this computer (§10.7).
 *
 * Wraps ccusage, which parses Claude Code's local transcripts. No Anthropic
 * API is called and nothing is uploaded — C1.
 *
 * Flags were checked against the installed ccusage rather than copied from the
 * spec: §5.8 lists `--instances` and `--breakdown`, and neither exists in
 * ccusage 20 (it answers `Unknown option '--instances'`). Per-model figures
 * arrive inside the JSON instead, and per-project totals are not available at
 * all. We say so rather than inventing a number.
 */

export type Period = "daily" | "weekly" | "monthly" | "session";
export const PERIODS: Period[] = ["daily", "weekly", "monthly", "session"];

export const PERIOD_LABEL: Record<Period, string> = {
  daily: "By day",
  weekly: "By week",
  monthly: "By month",
  session: "By conversation",
};

export interface ModelSplit {
  model: string;
  cost: number;
}

export interface UsageRow {
  label: string;
  cost: number;
  totalTokens: number;
  models: ModelSplit[];
}

export interface UsageReport {
  rows: UsageRow[];
  totalCost: number;
}

export type UsageOutcome =
  | { ok: true; report: UsageReport }
  | { ok: false; message: string; detail: string };

interface CacheEntry {
  at: number;
  outcome: UsageOutcome;
}
const cache = new Map<Period, CacheEntry>();
const CACHE_MS = 60_000; // §10.7

function asNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * The array key follows the subcommand name (`daily` -> `daily`), so it is
 * read from the payload rather than hardcoded per period.
 */
function extractRows(payload: Record<string, unknown>, period: Period): unknown[] {
  const direct = payload[period];
  if (Array.isArray(direct)) return direct;
  for (const [key, value] of Object.entries(payload)) {
    if (key !== "totals" && Array.isArray(value)) return value;
  }
  return [];
}

function rowLabel(row: Record<string, unknown>): string {
  for (const key of ["period", "date", "month", "week", "sessionId", "session", "project"]) {
    const v = row[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "unknown";
}

export function parseUsage(raw: unknown, period: Period): UsageReport {
  const payload = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const rows: UsageRow[] = [];

  for (const item of extractRows(payload, period)) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const breakdowns = Array.isArray(row["modelBreakdowns"])
      ? (row["modelBreakdowns"] as unknown[])
      : [];

    rows.push({
      label: rowLabel(row),
      cost: asNumber(row["totalCost"]),
      totalTokens: asNumber(row["totalTokens"]),
      models: breakdowns
        .filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null)
        .map((b) => ({
          model: typeof b["modelName"] === "string" ? b["modelName"] : "unknown",
          cost: asNumber(b["cost"]),
        }))
        .sort((a, b) => b.cost - a.cost),
    });
  }

  const totals = payload["totals"];
  const totalCost =
    typeof totals === "object" && totals !== null
      ? asNumber((totals as Record<string, unknown>)["totalCost"])
      : rows.reduce((n, r) => n + r.cost, 0);

  return { rows: rows.reverse(), totalCost };
}

export async function getUsage(period: Period, now = Date.now()): Promise<UsageOutcome> {
  const hit = cache.get(period);
  if (hit && now - hit.at < CACHE_MS) return hit.outcome;

  let outcome: UsageOutcome;
  try {
    const { stdout } = await run("npx", ["-y", "ccusage@latest", period, "--json"], {
      timeout: 90_000,
      maxBuffer: 32 * 1024 * 1024,
      encoding: "utf8",
    });
    outcome = { ok: true, report: parseUsage(JSON.parse(stdout), period) };
  } catch (err) {
    // Never a fake zero (§10.7): say plainly that we couldn't read it.
    outcome = {
      ok: false,
      message: "Can't read your usage right now.",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  cache.set(period, { at: now, outcome });
  return outcome;
}

export function formatMoney(cost: number): string {
  if (cost >= 1000) return `$${(cost / 1000).toFixed(1)}k`;
  return `$${cost.toFixed(2)}`;
}

/** Model ids mean nothing to our reader; the family is what they recognise. */
export function friendlyModel(modelName: string): string {
  const m = modelName.toLowerCase();
  for (const family of ["opus", "sonnet", "haiku", "fable"]) {
    if (m.includes(family)) return family.charAt(0).toUpperCase() + family.slice(1);
  }
  return modelName;
}

/** §10.7 — the limit we refuse to paper over. */
export const ATTRIBUTION_LIMIT =
  "We can show what each day and each model cost. We can't split it by individual tool or ability — that isn't recorded anywhere on your computer.";

export const PRIVACY_NOTE =
  "This is worked out from files on your computer. Nothing was sent anywhere.";

export function _clearCacheForTests(): void {
  cache.clear();
}
