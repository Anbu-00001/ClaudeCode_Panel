import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { RepoInfo } from "./paths.js";

/**
 * How many times each tool / MCP server was actually called, scoped to this
 * folder and (for readSessionUsage) its most recent session.
 *
 * ccusage.ts already reads Claude Code's local transcripts, but only for
 * spending — §10.7 is explicit that per-tool attribution "isn't recorded
 * anywhere ccusage looks." It is recorded, just not by ccusage: every
 * tool_use block in the transcript itself. So this reads the same files
 * ccusage.ts's ATTRIBUTION_LIMIT says can't be split by tool — directly,
 * without shelling out — rather than duplicating ccusage's own conventions
 * for what "reading a local transcript safely" means.
 */

export interface ToolUsage {
  calls: number;
  lastUsed: Date | null;
}

export interface UsageReport {
  /** MCP server name (the middle segment of mcp__server__tool) → usage. */
  byServer: Map<string, ToolUsage>;
  /** Every tool name as it appears, built-in or MCP → usage. */
  byTool: Map<string, ToolUsage>;
  totalCalls: number;
  sessions: number;
  transcriptsFound: number;
  /** null when there are no transcripts for this folder at all. */
  latestSessionId: string | null;
}

export interface UsageOptions {
  /** Override for tests — production code never needs this (defaults to the real home). */
  home?: string;
  /** Bypass folder-encoding and point straight at a directory (tests only). */
  transcriptDir?: string;
}

/**
 * `~/.claude/projects/<encoded-folder>/<sessionId>.jsonl`. Encoding verified
 * against 19 real project dirs on this machine with zero mismatches: every
 * character outside [a-zA-Z0-9] becomes `-`, including the leading `/`.
 */
export function transcriptDirFor(folder: string, home: string = homedir()): string {
  const encoded = folder.replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(home, ".claude", "projects", encoded);
}

/**
 * tools.ts already established the rule for which folder Claude Code treats
 * as "this project": git root, falling back to cwd — the same thing
 * paths.ts computes as projectDir for ~/.claude.json's own projects[<dir>]
 * key. The transcripts directory is keyed on that same identity, so we reuse
 * projectDir rather than cwd.
 */
function resolveTranscriptDir(repo: RepoInfo, options?: UsageOptions): string {
  if (options?.transcriptDir) return options.transcriptDir;
  return transcriptDirFor(repo.projectDir, options?.home ?? homedir());
}

interface Transcript {
  sessionId: string;
  filePath: string;
  mtimeMs: number;
}

const EXT = ".jsonl";

function discoverTranscripts(dir: string): Transcript[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // no transcripts dir at all — caller sees transcriptsFound === 0, i.e. "unknown", not "zero"
  }

  const out: Transcript[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(EXT)) continue;
    const filePath = path.join(dir, entry.name);
    try {
      out.push({
        sessionId: entry.name.slice(0, -EXT.length),
        filePath,
        mtimeMs: fs.statSync(filePath).mtimeMs,
      });
    } catch {
      continue; // vanished between readdir and stat — not fatal, just not counted
    }
  }

  // Newest first. mtime is the cheap proxy for "most recent session": a live
  // session's own file is being appended to right now, so its mtime already
  // tracks that without parsing every transcript's content just to rank them.
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

interface Accumulator {
  byTool: Map<string, ToolUsage>;
  byServer: Map<string, ToolUsage>;
  totalCalls: number;
}

function newAccumulator(): Accumulator {
  return { byTool: new Map(), byServer: new Map(), totalCalls: 0 };
}

function bump(map: Map<string, ToolUsage>, key: string, when: Date | null): void {
  const cur = map.get(key) ?? { calls: 0, lastUsed: null };
  cur.calls += 1;
  if (when && (!cur.lastUsed || when > cur.lastUsed)) cur.lastUsed = when;
  map.set(key, cur);
}

/**
 * The server is whatever sits between the first and second `__` (real
 * examples: mcp__codegraph__codegraph_explore, mcp__serena__get_symbols_overview).
 * Never hardcoded — anything not shaped like an MCP tool name has no server.
 */
function serverNameFor(toolName: string): string | null {
  if (!toolName.startsWith("mcp__")) return null;
  const rest = toolName.slice("mcp__".length);
  const idx = rest.indexOf("__");
  const server = idx === -1 ? rest : rest.slice(0, idx);
  return server.length > 0 ? server : null;
}

function recordLine(line: string, acc: Accumulator): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return; // malformed, or the truncated tail of a session still being written
  }
  if (typeof parsed !== "object" || parsed === null) return;
  const entry = parsed as Record<string, unknown>;

  const message = entry["message"];
  if (typeof message !== "object" || message === null) return;
  const content = (message as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return; // e.g. a plain user turn, where content is a bare string

  const ts = entry["timestamp"];
  const parsedTs = typeof ts === "string" ? new Date(ts) : null;
  const when = parsedTs && !Number.isNaN(parsedTs.getTime()) ? parsedTs : null;

  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b["type"] !== "tool_use") continue;
    const name = b["name"];
    if (typeof name !== "string" || name.length === 0) continue;

    bump(acc.byTool, name, when);
    acc.totalCalls += 1;
    const server = serverNameFor(name);
    if (server) bump(acc.byServer, server, when);
  }
}

/**
 * Streams one transcript line-by-line instead of reading a multi-MB file into
 * one string, and cheaply skips anything that can't be a tool call before
 * paying for JSON.parse. Returns whether the file was reachable at all — that,
 * not "did it have calls," is what separates "0 calls" from "unreadable" in
 * the session count.
 */
async function processFile(filePath: string, acc: Accumulator): Promise<boolean> {
  let reached = false;
  try {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        reached = true;
        if (!line.includes("tool_use")) continue; // most lines aren't tool calls at all
        recordLine(line, acc);
      }
      return true; // drained cleanly, even if it turned out to hold zero calls
    } finally {
      rl.close();
      stream.destroy();
    }
  } catch {
    // Errored before or during the read (permission denied, file replaced
    // mid-scan, etc). If lines were already folded into acc, keep them —
    // only report unreachable when nothing was ever read.
    return reached;
  }
}

async function buildReport(dir: string, pick: (all: Transcript[]) => Transcript[]): Promise<UsageReport> {
  const all = discoverTranscripts(dir);
  const targets = pick(all);

  const acc = newAccumulator();
  let sessions = 0;
  for (const t of targets) {
    if (await processFile(t.filePath, acc)) sessions += 1;
  }

  return {
    byServer: acc.byServer,
    byTool: acc.byTool,
    totalCalls: acc.totalCalls,
    sessions,
    transcriptsFound: all.length,
    latestSessionId: all[0]?.sessionId ?? null,
  };
}

/** Every tool call recorded for this folder, across every session on disk. */
export async function readFolderUsage(repo: RepoInfo, options?: UsageOptions): Promise<UsageReport> {
  return buildReport(resolveTranscriptDir(repo, options), (all) => all);
}

/** Same shape, narrowed to whichever transcript was written to most recently. */
export async function readSessionUsage(repo: RepoInfo, options?: UsageOptions): Promise<UsageReport> {
  return buildReport(resolveTranscriptDir(repo, options), (all) => (all[0] ? [all[0]] : []));
}
