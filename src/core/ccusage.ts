import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { atomicWriteFile, ccpanelHome, ensureDir } from "./write.js";

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

/**
 * An exact version, never `@latest`: `npx -y` runs whatever it downloads with
 * the user's own permissions, so "latest" would mean running code nobody here
 * has looked at, published minutes ago. Bump this on purpose, after checking
 * the JSON still has the shape parseUsage reads.
 */
export const CCUSAGE_VERSION = "20.0.26";

/** The exact command the Spending screen runs. */
export function ccusageArgv(period: Period): string[] {
  return ["npx", "-y", `ccusage@${CCUSAGE_VERSION}`, period, "--json"];
}

/**
 * Where npx runs from, and with which npm settings.
 *
 * npx looks in the current folder first: a project that ships its own
 * node_modules/ccusage (or a .npmrc pointing at another registry) would have
 * that code run the moment Spending opens, if we ran npx from the project.
 * So it runs from a folder ccpanel owns, with the public registry named
 * outright and an empty user config, so neither the project's nor a stray
 * npm setting can swap in a different package.
 */
export function ccusageRunDir(): string {
  return path.join(ccpanelHome(), "run");
}

export function ccusageRunOptions(): { cwd: string; env: NodeJS.ProcessEnv } {
  const dir = ccusageRunDir();
  ensureDir(dir);
  const emptyNpmrc = path.join(dir, "empty.npmrc");
  if (!fs.existsSync(emptyNpmrc)) atomicWriteFile(emptyNpmrc, "");
  // Any npm_config_* the parent shell set is dropped too: those win over
  // every config file, so leaving them would undo the two lines below.
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^npm_config_/i.test(key)) env[key] = value;
  }
  env["npm_config_registry"] = "https://registry.npmjs.org/";
  env["npm_config_userconfig"] = emptyNpmrc;
  return { cwd: dir, env };
}

export async function getUsage(period: Period, now = Date.now()): Promise<UsageOutcome> {
  const hit = cache.get(period);
  if (hit && now - hit.at < CACHE_MS) return hit.outcome;

  let outcome: UsageOutcome;
  try {
    const [file, ...args] = ccusageArgv(period);
    const { stdout } = await run(file as string, args, {
      ...ccusageRunOptions(),
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

/**
 * Precise on purpose. The usage itself is read from local files and never
 * leaves the machine, but this screen does use the network: npx downloads
 * ccusage the first time, and ccusage fetches the public model price list.
 * "Nothing was sent anywhere" would have been a comforting overstatement.
 */
export const PRIVACY_NOTE =
  "Worked out from files on your computer; your usage isn't sent anywhere. To do the sums it downloads the ccusage tool (first time only) and a public list of model prices.";

export function _clearCacheForTests(): void {
  cache.clear();
}
