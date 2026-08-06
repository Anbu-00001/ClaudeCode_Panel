import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { type ClaudePaths, type RepoInfo, getClaudePaths } from "./paths.js";
import { validateByFilename } from "./validate.js";
import { atomicWriteFile, backupsDir, describeParseError, snapshot, sweepStaleTempFiles } from "./write.js";

/**
 * Config health check and restore (§10.8). Runs on demand, and whenever a
 * write aborts because a file wouldn't parse.
 */

export type FileHealth = "ok" | "missing" | "broken" | "questionable";

export interface FileStatus {
  filePath: string;
  /** Plain-language name for the UI — never the raw path (§8.2). */
  plainName: string;
  health: FileHealth;
  message: string | null;
  line: number | null;
  column: number | null;
  issues: Array<{ path: string; message: string }>;
}

export interface RestoreCandidate {
  backupPath: string;
  /** "claude-code" for Claude Code's own rotating backups, "ccpanel" for ours. */
  source: "claude-code" | "ccpanel";
  takenAt: Date | null;
  sizeBytes: number;
}

function claudeCodeBackupsDir(): string {
  return path.join(homedir(), ".claude", "backups");
}

function inspect(filePath: string, plainName: string): FileStatus {
  const base: FileStatus = {
    filePath,
    plainName,
    health: "ok",
    message: null,
    line: null,
    column: null,
    issues: [],
  };

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...base, health: "missing" };
    }
    return { ...base, health: "broken", message: (err as Error).message };
  }

  if (raw.trim() === "") return { ...base, health: "ok" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const failure = describeParseError(filePath, err);
    return {
      ...base,
      health: "broken",
      message: failure.message,
      line: failure.line,
      column: failure.column,
    };
  }

  const validation = validateByFilename(filePath, parsed);
  if (!validation.ok) {
    // Parses fine, but a value isn't shaped the way Claude Code expects.
    // Not "broken" — Claude Code may still accept it, and we never model
    // every key. Reported so the user can look, not as a failure.
    return { ...base, health: "questionable", issues: validation.issues };
  }

  return base;
}

/** Checks every config file ccpanel knows about. */
export function checkConfigFiles(repo: RepoInfo): FileStatus[] {
  const paths: ClaudePaths = getClaudePaths(repo);

  // Clear temp files orphaned by a previously killed ccpanel before reporting,
  // so Repair doesn't leave litter next to the user's config.
  for (const dir of new Set([
    path.dirname(paths.userSettings),
    path.dirname(paths.projectSettings),
    path.dirname(paths.projectMcp),
  ])) {
    sweepStaleTempFiles(dir);
  }

  return [
    inspect(paths.userSettings, "Your setup, for all your folders"),
    inspect(paths.projectSettings, "Your setup for this folder"),
    inspect(paths.localSettings, "Your setup for this folder, just for you"),
    inspect(paths.projectMcp, "Tools for this folder"),
    inspect(paths.userClaudeJson, "Claude Code's own record of your folders"),
  ];
}

export function hasProblems(statuses: FileStatus[]): boolean {
  return statuses.some((s) => s.health === "broken");
}

function parseClaudeCodeStamp(name: string): Date | null {
  // Verified on disk: `.claude.json.backup.1785997008771` — a unix ms stamp.
  const match = /\.(?:backup|corrupted)\.(\d{10,})$/.exec(name);
  if (!match?.[1]) return null;
  const ms = Number(match[1]);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function parseCcpanelStamp(name: string): Date | null {
  // Ours: `<iso8601>-<basename>`.
  const match = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)-/.exec(name);
  if (!match?.[1]) return null;
  const d = new Date(match[1]);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Every backup that could restore this file, newest first — ours and Claude
 * Code's own rotating five (§5.7).
 */
export function findRestoreCandidates(filePath: string): RestoreCandidate[] {
  const target = path.basename(filePath);
  const out: RestoreCandidate[] = [];

  const ours = backupsDir();
  let ourEntries: string[] = [];
  try {
    ourEntries = fs.readdirSync(ours);
  } catch {
    ourEntries = [];
  }
  for (const name of ourEntries) {
    if (!name.endsWith(`-${target}`)) continue;
    const full = path.join(ours, name);
    try {
      out.push({
        backupPath: full,
        source: "ccpanel",
        takenAt: parseCcpanelStamp(name),
        sizeBytes: fs.statSync(full).size,
      });
    } catch {
      continue;
    }
  }

  const theirs = claudeCodeBackupsDir();
  let theirEntries: string[] = [];
  try {
    theirEntries = fs.readdirSync(theirs);
  } catch {
    theirEntries = [];
  }
  for (const name of theirEntries) {
    // `.claude.json.backup.<ms>` / `.claude.json.corrupted.<ms>`
    if (!name.startsWith(`${target}.`)) continue;
    const full = path.join(theirs, name);
    try {
      out.push({
        backupPath: full,
        source: "claude-code",
        takenAt: parseClaudeCodeStamp(name),
        sizeBytes: fs.statSync(full).size,
      });
    } catch {
      continue;
    }
  }

  return out.sort((a, b) => (b.takenAt?.getTime() ?? 0) - (a.takenAt?.getTime() ?? 0));
}

export interface RestoreResult {
  ok: boolean;
  message: string;
  backupOfBroken: string | null;
}

/**
 * Restores a backup over a config file. The broken file is itself snapshotted
 * first, so choosing the wrong backup is also reversible.
 */
export function restoreFromBackup(backupPath: string, targetPath: string): RestoreResult {
  let raw: string;
  try {
    raw = fs.readFileSync(backupPath, "utf8");
  } catch (err) {
    return { ok: false, message: `Couldn't read that backup: ${(err as Error).message}`, backupOfBroken: null };
  }

  try {
    JSON.parse(raw);
  } catch {
    return {
      ok: false,
      message: "That backup is damaged too. Try an older one.",
      backupOfBroken: null,
    };
  }

  let backupOfBroken: string | null = null;
  try {
    backupOfBroken = snapshot(targetPath);
    atomicWriteFile(targetPath, raw);
  } catch (err) {
    return { ok: false, message: (err as Error).message, backupOfBroken };
  }

  return { ok: true, message: "Restored.", backupOfBroken };
}

/** Surfaced as a copyable command rather than run for the user (§15). */
export const DOCTOR_COMMAND = "claude doctor";
