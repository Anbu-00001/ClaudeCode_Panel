import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { maskText } from "./mask.js";
import {
  type RecordedChange,
  type TransactionMeta,
  appendLine,
  atomicWriteFile,
  ccpanelHome,
  revertChanges,
} from "./write.js";

/** Append-only history of everything ccpanel changed (§12.3). */

const MAX_ENTRIES = 500;

export interface UndoEntry {
  uid: string;
  ts: string;
  kind: string;
  id: string;
  label: string;
  changes: RecordedChange[];
  /** Set when this entry is itself the reversal of an earlier one. */
  revertOf?: string;
}

export function undoLogPath(): string {
  return path.join(ccpanelHome(), "undo.jsonl");
}

export function appendUndoEntry(
  meta: TransactionMeta,
  changes: RecordedChange[],
  opts: { revertOf?: string } = {},
): UndoEntry {
  const entry: UndoEntry = {
    uid: crypto.randomBytes(6).toString("hex"),
    ts: new Date().toISOString(),
    kind: meta.kind,
    id: meta.id,
    label: meta.label,
    changes,
  };
  if (opts.revertOf) entry.revertOf = opts.revertOf;

  // write.ts masks before/after already; this is a second pass over the whole
  // serialized line so a credential can't reach the log through a field we
  // didn't anticipate (acceptance test #5).
  appendLine(undoLogPath(), maskText(JSON.stringify(entry)));
  rotate();
  return entry;
}

export function readUndoLog(): UndoEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(undoLogPath(), "utf8");
  } catch {
    return [];
  }

  const entries: UndoEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      // A partially written final line is skipped rather than failing the
      // whole history.
      entries.push(JSON.parse(line) as UndoEntry);
    } catch {
      continue;
    }
  }
  return entries;
}

/** Most recent first — the order the Undo screen shows (§10.6). */
export function readUndoLogNewestFirst(): UndoEntry[] {
  return readUndoLog().reverse();
}

function rotate(): void {
  const entries = readUndoLog();
  if (entries.length <= MAX_ENTRIES) return;
  const kept = entries.slice(entries.length - MAX_ENTRIES);
  const body = kept.map((e) => maskText(JSON.stringify(e))).join("\n");
  atomicWriteFile(undoLogPath(), `${body}\n`);
}

export interface RevertResult {
  ok: boolean;
  failed: string[];
  entry?: UndoEntry;
}

/** Reverses one entry. The reversal is itself logged (§10.6). */
export function revertEntry(uid: string): RevertResult {
  const entry = readUndoLog().find((e) => e.uid === uid);
  if (!entry) return { ok: false, failed: [], entry: undefined };

  const result = revertChanges(entry.changes);
  if (result.ok) {
    appendUndoEntry(
      { kind: "undo", id: entry.id, label: `Undid: ${entry.label}` },
      entry.changes.map((c) => ({ ...c, backupPath: null })),
      { revertOf: entry.uid },
    );
  }
  return { ok: result.ok, failed: result.failed, entry };
}
