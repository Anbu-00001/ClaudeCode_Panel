import crypto from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { maskDeep } from "./mask.js";
import { validateByFilename } from "./validate.js";

/**
 * The only module permitted to mutate the filesystem (§7.1, §12.1).
 *
 * Every write follows the nine-step protocol in §12.1. The two properties
 * that matter most:
 *
 *  - The bytes on disk are only ever replaced by an atomic rename, so a crash
 *    leaves the complete old file or the complete new file, never a truncated
 *    one.
 *  - The object serialized is always the caller's mutated object, never a
 *    schema's output, so a key we don't model can't be dropped.
 */

/**
 * Config files can hold credentials, and Claude Code writes its own settings
 * as 0600. A default umask of 0002 would otherwise create our replacement at
 * 0664 — rename() gives the target the tmp file's mode, so writing naively
 * would silently widen a private file to world-readable.
 */
const DEFAULT_FILE_MODE = 0o600;
/** Kit payloads (agents, skills, hook scripts) are not secret. */
export const DEFAULT_CONTENT_MODE = 0o644;
export const EXECUTABLE_MODE = 0o755;

export function ccpanelHome(): string {
  return path.join(homedir(), ".claude", "ccpanel");
}

export function backupsDir(): string {
  return path.join(ccpanelHome(), "backups");
}

// ---------------------------------------------------------------------------
// Low-level primitives — the only fs mutation calls in the codebase.
// ---------------------------------------------------------------------------

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Flushes the directory entry so a completed rename survives a power loss.
 * Best-effort: not all filesystems permit it, and failing here doesn't make
 * the rename any less atomic.
 */
function fsyncDir(dirPath: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dirPath, "r");
    fs.fsyncSync(fd);
  } catch {
    /* best effort */
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function currentMode(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mode & 0o777;
  } catch {
    return null;
  }
}

/**
 * Writes via a temp file in the same directory, fsync, then rename (§12.1.7).
 * The original is never truncated.
 *
 * The temp name carries pid + random bytes: the spec's fixed `.ccpanel.tmp`
 * would collide if two ccpanel processes wrote the same file at once, and
 * §12.5 says we can't lock.
 */
export function atomicWriteFile(
  filePath: string,
  contents: string,
  opts: { mode?: number } = {},
): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);

  const mode = opts.mode ?? currentMode(filePath) ?? DEFAULT_FILE_MODE;
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.ccpanel.${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`,
  );

  let fd: number | undefined;
  try {
    fd = fs.openSync(tmpPath, "wx", mode);
    fs.writeFileSync(fd, contents, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // openSync's mode is masked by umask; chmod is not. Without this the
    // replacement of a 0600 file lands at 0664 under a default umask.
    fs.chmodSync(tmpPath, mode);
    fs.renameSync(tmpPath, filePath);
    fsyncDir(dir);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

const TMP_PATTERN = /^\..+\.ccpanel\.(\d+)-[0-9a-f]+\.tmp$/;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Removes temp files left behind by ccpanel processes that were killed
 * mid-write. A SIGKILL can't run cleanup, so these accumulate next to the
 * user's config otherwise — measured at ~1 per 2 crashes.
 *
 * Only files whose owning pid is gone are removed, so a concurrently running
 * ccpanel's in-flight write is never touched.
 */
export function sweepStaleTempFiles(dirPath: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const name of entries) {
    const match = TMP_PATTERN.exec(name);
    if (!match?.[1]) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || isProcessAlive(pid)) continue;
    try {
      fs.unlinkSync(path.join(dirPath, name));
      removed.push(name);
    } catch {
      continue;
    }
  }
  return removed;
}

export function appendLine(filePath: string, line: string): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${line}\n`, { encoding: "utf8", mode: DEFAULT_FILE_MODE });
}

export function removeFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function chmodFile(filePath: string, mode: number): void {
  fs.chmodSync(filePath, mode);
}

export function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Backups (§12.1.3)
// ---------------------------------------------------------------------------

/** Snapshots raw bytes. Returns null when there was no file to snapshot. */
export function snapshot(filePath: string): string | null {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const dir = backupsDir();
  ensureDir(dir);

  const stamp = new Date().toISOString();
  const base = path.basename(filePath);
  let target = path.join(dir, `${stamp}-${base}`);
  let n = 1;
  while (fs.existsSync(target)) {
    target = path.join(dir, `${stamp}-${n}-${base}`);
    n += 1;
  }

  // 0600: a snapshot of a secrets-bearing config is just as sensitive.
  fs.writeFileSync(target, raw, { mode: DEFAULT_FILE_MODE });
  fs.chmodSync(target, DEFAULT_FILE_MODE);
  return target;
}

function restoreSnapshot(backupPath: string, targetPath: string): void {
  const raw = fs.readFileSync(backupPath, "utf8");
  atomicWriteFile(targetPath, raw);
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

export interface ParseFailure {
  filePath: string;
  message: string;
  line: number | null;
  column: number | null;
}

/**
 * Node reports "…at position N (line L column C)" for most syntax errors, but
 * plain "Unexpected end of JSON input" for a truncated or empty file — verified
 * on Node 22. Both shapes must be handled.
 */
export function describeParseError(filePath: string, err: unknown): ParseFailure {
  const message = err instanceof Error ? err.message : String(err);
  const match = /line (\d+) column (\d+)/.exec(message);
  return {
    filePath,
    message,
    line: match?.[1] ? Number(match[1]) : null,
    column: match?.[2] ? Number(match[2]) : null,
  };
}

/** Serialized to match Claude Code's own style: 2-space indent, trailing newline. */
export function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJsonForWrite(filePath: string):
  | { status: "ok"; value: Record<string, unknown>; existed: boolean }
  | { status: "unparseable"; failure: ParseFailure } {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "ok", value: {}, existed: false };
    }
    throw err;
  }

  // An empty or whitespace-only file is treated as {} rather than a parse
  // failure: Claude Code tolerates it, and routing to Repair would be noise.
  if (raw.trim() === "") return { status: "ok", value: {}, existed: true };

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        status: "unparseable",
        failure: {
          filePath,
          message: "Expected the file to contain a JSON object.",
          line: null,
          column: null,
        },
      };
    }
    return { status: "ok", value: parsed as Record<string, unknown>, existed: true };
  } catch (err) {
    return { status: "unparseable", failure: describeParseError(filePath, err) };
  }
}

function getAtPath(obj: Record<string, unknown>, keyPath: string[]): unknown {
  let cursor: unknown = obj;
  for (const key of keyPath) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

// ---------------------------------------------------------------------------
// Fenced CLAUDE.md blocks (§9.2)
// ---------------------------------------------------------------------------

export function fenceOpen(id: string): string {
  return `<!-- ccpanel:${id} -->`;
}

export function fenceClose(id: string): string {
  return `<!-- /ccpanel:${id} -->`;
}

export function findFencedBlock(text: string, id: string): { start: number; end: number; body: string } | null {
  const open = fenceOpen(id);
  const close = fenceClose(id);
  const start = text.indexOf(open);
  if (start === -1) return null;
  const closeAt = text.indexOf(close, start + open.length);
  if (closeAt === -1) return null;
  return {
    start,
    end: closeAt + close.length,
    body: text.slice(start + open.length, closeAt).trim(),
  };
}

// ---------------------------------------------------------------------------
// Operations & transactions (§12.1)
// ---------------------------------------------------------------------------

export type Operation =
  | { kind: "createFile"; filePath: string; contents: string; mode?: number; overwrite?: boolean }
  | {
      kind: "patchJson";
      filePath: string;
      keyPath: string[];
      mutate: (draft: Record<string, unknown>) => void;
    }
  | { kind: "appendBlock"; filePath: string; blockId: string; content: string }
  | { kind: "removeBlock"; filePath: string; blockId: string }
  | { kind: "deleteFile"; filePath: string };

export interface RecordedChange {
  file: string;
  op: "create" | "patch" | "append-block" | "remove-block" | "delete";
  key?: string;
  before?: unknown;
  after?: unknown;
  backupPath: string | null;
  existedBefore: boolean;
  /** True when before/after were withheld because the value looked secret. */
  secretRedacted?: boolean;
  /** Set when a user edited inside a fenced block we were asked to remove. */
  userModified?: boolean;
}

export type WriteFailure =
  | { reason: "unparseable"; failure: ParseFailure }
  | { reason: "invalid"; filePath: string; issues: Array<{ path: string; message: string }> }
  | { reason: "verify-failed"; filePath: string; message: string }
  | { reason: "conflict"; filePath: string; message: string }
  | { reason: "error"; filePath: string; message: string };

export interface TransactionMeta {
  kind: string;
  id: string;
  label: string;
}

export interface TransactionResult {
  ok: boolean;
  changes: RecordedChange[];
  failure?: WriteFailure;
  /** True when rollback itself could not fully restore the disk. */
  rollbackIncomplete?: boolean;
}

/** Applies one operation, returning the change record needed to reverse it. */
function applyOperation(op: Operation): { ok: true; change: RecordedChange } | { ok: false; failure: WriteFailure } {
  switch (op.kind) {
    case "createFile": {
      const existed = fs.existsSync(op.filePath);
      if (existed && op.overwrite !== true) {
        const existing = fs.readFileSync(op.filePath, "utf8");
        if (existing !== op.contents) {
          return {
            ok: false,
            failure: {
              reason: "conflict",
              filePath: op.filePath,
              message: "A different file is already there.",
            },
          };
        }
      }
      const backupPath = snapshot(op.filePath);
      atomicWriteFile(op.filePath, op.contents, { mode: op.mode ?? DEFAULT_CONTENT_MODE });
      return {
        ok: true,
        change: { file: op.filePath, op: "create", backupPath, existedBefore: existed },
      };
    }

    case "patchJson": {
      // 1 & 2. Read and parse. Unparseable aborts without touching anything.
      const read = readJsonForWrite(op.filePath);
      if (read.status === "unparseable") {
        return { ok: false, failure: { reason: "unparseable", failure: read.failure } };
      }

      // 3. Snapshot raw bytes before any mutation.
      const backupPath = snapshot(op.filePath);

      // 4. Mutate in memory — only the keys this operation owns.
      const before = structuredClone(getAtPath(read.value, op.keyPath));
      op.mutate(read.value);
      const after = structuredClone(getAtPath(read.value, op.keyPath));

      // 5. Validate. Issues abort the write; nothing has been written yet.
      const validation = validateByFilename(op.filePath, read.value);
      if (!validation.ok) {
        return {
          ok: false,
          failure: { reason: "invalid", filePath: op.filePath, issues: validation.issues },
        };
      }

      // 6 & 7. Serialize the caller's object (never schema output) and rename.
      const serialized = serializeJson(read.value);
      atomicWriteFile(op.filePath, serialized);

      // 8. Re-read and re-parse; restore the snapshot if it didn't survive.
      const verify = readJsonForWrite(op.filePath);
      if (verify.status === "unparseable") {
        if (backupPath) restoreSnapshot(backupPath, op.filePath);
        else removeFile(op.filePath);
        return {
          ok: false,
          failure: {
            reason: "verify-failed",
            filePath: op.filePath,
            message: verify.failure.message,
          },
        };
      }

      const redacted = hasSecret(before) || hasSecret(after);
      const change: RecordedChange = {
        file: op.filePath,
        op: "patch",
        key: op.keyPath.join("."),
        before: maskDeep(before),
        after: maskDeep(after),
        backupPath,
        existedBefore: read.existed,
      };
      if (redacted) change.secretRedacted = true;
      return { ok: true, change };
    }

    case "appendBlock": {
      const existed = fs.existsSync(op.filePath);
      const existing = existed ? fs.readFileSync(op.filePath, "utf8") : "";
      if (findFencedBlock(existing, op.blockId)) {
        return {
          ok: false,
          failure: {
            reason: "conflict",
            filePath: op.filePath,
            message: "This block is already in the file.",
          },
        };
      }
      const backupPath = snapshot(op.filePath);
      const prefix = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
      const block = `${fenceOpen(op.blockId)}\n${op.content.trim()}\n${fenceClose(op.blockId)}\n`;
      atomicWriteFile(op.filePath, `${prefix}${prefix.length > 0 ? "\n" : ""}${block}`, {
        mode: existed ? undefined : DEFAULT_CONTENT_MODE,
      } as { mode?: number });
      return {
        ok: true,
        change: { file: op.filePath, op: "append-block", key: op.blockId, backupPath, existedBefore: existed },
      };
    }

    case "removeBlock": {
      if (!fs.existsSync(op.filePath)) {
        return { ok: true, change: { file: op.filePath, op: "remove-block", key: op.blockId, backupPath: null, existedBefore: false } };
      }
      const existing = fs.readFileSync(op.filePath, "utf8");
      const found = findFencedBlock(existing, op.blockId);
      if (!found) {
        return { ok: true, change: { file: op.filePath, op: "remove-block", key: op.blockId, backupPath: null, existedBefore: true } };
      }
      const backupPath = snapshot(op.filePath);
      // Removes exactly the fenced region, so text above and below survives.
      const head = existing.slice(0, found.start).replace(/\n+$/, "\n");
      const tail = existing.slice(found.end).replace(/^\n+/, "");
      const next = `${head}${tail}`;
      atomicWriteFile(op.filePath, next);
      return {
        ok: true,
        change: { file: op.filePath, op: "remove-block", key: op.blockId, backupPath, existedBefore: true },
      };
    }

    case "deleteFile": {
      const existed = fs.existsSync(op.filePath);
      const backupPath = existed ? snapshot(op.filePath) : null;
      removeFile(op.filePath);
      return {
        ok: true,
        change: { file: op.filePath, op: "delete", backupPath, existedBefore: existed },
      };
    }
  }
}

function hasSecret(value: unknown): boolean {
  const masked = JSON.stringify(maskDeep(value) ?? null);
  const plain = JSON.stringify(value ?? null);
  return masked !== plain;
}

/** Reverses a single applied change, restoring the exact prior bytes. */
function revertChange(change: RecordedChange): void {
  if (!change.existedBefore) {
    removeFile(change.file);
    return;
  }
  if (change.backupPath) {
    restoreSnapshot(change.backupPath, change.file);
  }
}

/**
 * Applies operations as a unit (§12.1). If any step fails, every step already
 * applied is rolled back in reverse order and the disk is left as it was.
 */
export function runTransaction(
  ops: Operation[],
  meta: TransactionMeta,
  recordUndo?: (meta: TransactionMeta, changes: RecordedChange[]) => void,
): TransactionResult {
  const applied: RecordedChange[] = [];

  for (const op of ops) {
    let result: ReturnType<typeof applyOperation>;
    try {
      result = applyOperation(op);
    } catch (err) {
      result = {
        ok: false,
        failure: {
          reason: "error",
          filePath: "filePath" in op ? op.filePath : "(unknown)",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    if (!result.ok) {
      let rollbackIncomplete = false;
      for (const change of [...applied].reverse()) {
        try {
          revertChange(change);
        } catch {
          rollbackIncomplete = true;
        }
      }
      const out: TransactionResult = { ok: false, changes: [], failure: result.failure };
      if (rollbackIncomplete) out.rollbackIncomplete = true;
      return out;
    }

    applied.push(result.change);
  }

  // 9. Record the whole install as one undo entry.
  recordUndo?.(meta, applied);
  return { ok: true, changes: applied };
}

/** Reverses a previously recorded set of changes (the Undo screen's engine). */
export function revertChanges(changes: RecordedChange[]): { ok: boolean; failed: string[] } {
  const failed: string[] = [];
  for (const change of [...changes].reverse()) {
    try {
      revertChange(change);
    } catch {
      failed.push(change.file);
    }
  }
  return { ok: failed.length === 0, failed };
}
