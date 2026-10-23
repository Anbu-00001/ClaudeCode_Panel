import crypto from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { maskDeep } from "./mask.js";
import { getClaudePaths, gitExcludeFile, type RepoInfo } from "./paths.js";
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

/**
 * A cheap "has this file changed?" stamp: inode, size, and modification time.
 * Not a hash — hashing ~/.claude.json on every write would cost more than it
 * is worth, and this catches every real case except a rewrite that lands in
 * the same millisecond at byte-identical length.
 */
function fileFingerprint(filePath: string): string | null {
  try {
    const s = fs.statSync(filePath);
    return `${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch {
    return null; // missing is itself a state: it must still be missing later.
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
  requestedPath: string,
  contents: string,
  opts: { mode?: number } = {},
): void {
  // Renaming over a symlink would replace the link itself with a plain file,
  // cutting it off from wherever the user keeps the real one (a dotfiles
  // repo, say). Write next to the real file instead, so the link survives.
  const filePath = followSymlink(requestedPath);
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

/**
 * Where a write to `filePath` would really land, following links in the file
 * and in every folder above it. For a path that doesn't exist yet, the
 * nearest existing folder is resolved and the rest added back on.
 */
export function realTarget(filePath: string, depth = 0): string {
  // A loop of links never resolves; stop following and take the path as given.
  if (depth > 40) return path.resolve(filePath);
  const missing: string[] = [];
  let current = path.resolve(filePath);
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...missing.reverse());
    } catch {
      let isDanglingLink = false;
      try {
        isDanglingLink = fs.lstatSync(current).isSymbolicLink();
      } catch {
        /* nothing there */
      }
      if (isDanglingLink) {
        // A link to something that doesn't exist yet: follow it by hand.
        const target = path.resolve(path.dirname(current), fs.readlinkSync(current));
        return path.join(realTarget(target, depth + 1), ...missing.reverse());
      }
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...missing.reverse());
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * For a file inside `projectDir`, the real place it points to when that is
 * outside the project; otherwise null. Files that aren't in the project
 * (the user's own ~/.claude) aren't this check's business.
 */
export function escapesProject(filePath: string, projectDir: string): string | null {
  const inside = (child: string, parent: string) => {
    const rel = path.relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  if (!inside(path.resolve(filePath), path.resolve(projectDir))) return null;
  const real = realTarget(filePath);
  return inside(real, realTarget(projectDir)) ? null : real;
}

/** The file a symlink points to (through any chain of links), or the path itself. */
function followSymlink(filePath: string): string {
  let isLink = false;
  try {
    isLink = fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return filePath; // nothing there yet: an ordinary new file
  }
  if (!isLink) return filePath;
  try {
    return fs.realpathSync(filePath);
  } catch {
    // A link to a file that doesn't exist yet: create it where the link points.
    return path.resolve(path.dirname(filePath), fs.readlinkSync(filePath));
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
 * ccpanel's in-flight write is never touched. `minAgeMs` also spares any file
 * younger than that, in case a pid was reused by an unrelated process.
 */
export function sweepStaleTempFiles(
  dirPath: string,
  minAgeMs = 0,
  now: number = Date.now(),
): string[] {
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
      if (minAgeMs > 0 && now - fs.statSync(path.join(dirPath, name)).mtimeMs < minAgeMs) continue;
      fs.unlinkSync(path.join(dirPath, name));
      removed.push(name);
    } catch {}
  }
  return removed;
}

/**
 * Adds `filePath` to the repository's own ignore list (.git/info/exclude) so
 * git doesn't offer to commit it. Does nothing outside a repository, when the
 * line is already there, or if the list can't be written: this is a
 * courtesy, never a reason to fail the change that prompted it.
 */
export function ensureGitExcluded(filePath: string): void {
  try {
    const exclude = gitExcludeFile(path.dirname(filePath));
    if (!exclude) return;
    const rel = path.relative(realTarget(exclude.root), realTarget(filePath));
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return;
    const pattern = `/${rel.split(path.sep).join("/")}`;
    let current = "";
    try {
      current = fs.readFileSync(exclude.file, "utf8");
    } catch {
      /* no list yet */
    }
    const lines = current.split(/\r?\n/).map((l) => l.trim());
    if (lines.includes(pattern) || lines.includes(pattern.slice(1))) return;
    const sep = current === "" || current.endsWith("\n") ? "" : "\n";
    atomicWriteFile(exclude.file, `${current}${sep}${pattern}\n`, {
      mode: currentMode(exclude.file) ?? DEFAULT_CONTENT_MODE,
    });
  } catch {
    /* best effort */
  }
}

/** How old a leftover temp file must be before startup clears it away. */
export const STARTUP_SWEEP_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * Clears temp files a killed ccpanel left beside the config files it writes:
 * ~/.claude, ~ (for ~/.claude.json), the project's .claude folder and the
 * project folder itself (.mcp.json, CLAUDE.md). Only ccpanel's own temp-file
 * names, from processes that are gone, at least an hour old.
 */
export function sweepConfigTempFiles(repo: RepoInfo, now: number = Date.now()): string[] {
  const paths = getClaudePaths(repo);
  const dirs = new Set(
    [paths.userSettings, paths.userClaudeJson, paths.projectSettings, paths.projectMcp].map((f) =>
      path.dirname(f),
    ),
  );
  const removed: string[] = [];
  for (const dir of dirs) {
    for (const name of sweepStaleTempFiles(dir, STARTUP_SWEEP_MIN_AGE_MS, now)) {
      removed.push(path.join(dir, name));
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

/** Backups older than this are deleted the next time ccpanel takes one. */
export const BACKUP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** And at most this many are kept for any one file. */
export const BACKUP_KEEP_PER_FILE = 20;

/**
 * The part of a backup's name that says which file it is a copy of. The base
 * name alone isn't enough: every project has a `.claude/settings.json`, and
 * restoring one project's copy into another would be worse than no backup.
 * So it carries a short hash of the full path too.
 */
export function backupKey(filePath: string): string {
  const hash = crypto.createHash("sha256").update(path.resolve(filePath)).digest("hex").slice(0, 8);
  return `${hash}-${path.basename(filePath)}`;
}

/**
 * Keeps the backups folder from growing forever: anything older than
 * BACKUP_MAX_AGE_MS goes, and for the file just backed up only the newest
 * BACKUP_KEEP_PER_FILE copies stay. Best-effort — a backup that couldn't be
 * pruned is never a reason to fail the write that made it.
 */
export function pruneBackups(key: string, now: number = Date.now()): string[] {
  const dir = backupsDir();
  const removed: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return removed;
  }

  const mine: Array<{ full: string; mtime: number }> = [];
  for (const name of names) {
    const full = path.join(dir, name);
    let mtime: number;
    try {
      mtime = fs.statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtime > BACKUP_MAX_AGE_MS) {
      try {
        removeFile(full);
        removed.push(full);
      } catch {}
      continue;
    }
    if (name.endsWith(`-${key}`)) mine.push({ full, mtime });
  }

  mine.sort((a, b) => b.mtime - a.mtime || b.full.localeCompare(a.full));
  for (const old of mine.slice(BACKUP_KEEP_PER_FILE)) {
    try {
      removeFile(old.full);
      removed.push(old.full);
    } catch {}
  }
  return removed;
}

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
  const key = backupKey(filePath);
  let target = path.join(dir, `${stamp}-${key}`);
  let n = 1;
  while (fs.existsSync(target)) {
    target = path.join(dir, `${stamp}-${n}-${key}`);
    n += 1;
  }

  // 0600: a snapshot of a secrets-bearing config is just as sensitive.
  fs.writeFileSync(target, raw, { mode: DEFAULT_FILE_MODE });
  fs.chmodSync(target, DEFAULT_FILE_MODE);
  pruneBackups(key);
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

/**
 * A parse failure in words: which file, and where in it, so the user can go
 * straight to the typo. Paths inside `baseDir` are shown relative to it.
 */
export function describeParseFailure(failure: ParseFailure, baseDir?: string): string {
  const rel = baseDir ? path.relative(baseDir, failure.filePath) : "";
  const name = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : failure.filePath;
  const where =
    failure.line !== null
      ? ` at line ${failure.line}${failure.column !== null ? `, column ${failure.column}` : ""}`
      : "";
  return `${name} has a typo in it${where}, so it wasn't safe to change. Nothing was touched. Fix that, then try again.`;
}

/** Serialized to match Claude Code's own style: 2-space indent, trailing newline. */
export function serializeJson(
  value: unknown,
  style: JsonStyle = { indent: "  ", trailingNewline: true },
): string {
  return `${JSON.stringify(value, null, style.indent)}${style.trailingNewline ? "\n" : ""}`;
}

export interface JsonStyle {
  indent: string;
  trailingNewline: boolean;
}

/**
 * How an existing file is laid out, so a one-key change doesn't reformat a
 * file someone keeps at 4 spaces or tabs into a whole-file diff. The indent
 * is read from the first indented line; a file with none (empty, or all on
 * one line) gets Claude Code's 2 spaces.
 */
export function detectJsonStyle(raw: string): JsonStyle {
  const indent = /\n([ \t]+)\S/.exec(raw)?.[1] ?? "  ";
  return { indent, trailingNewline: raw.length === 0 || raw.endsWith("\n") };
}

function readJsonForWrite(
  filePath: string,
):
  | { status: "ok"; value: Record<string, unknown>; existed: boolean; style: JsonStyle }
  | { status: "unparseable"; failure: ParseFailure } {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "ok", value: {}, existed: false, style: detectJsonStyle("") };
    }
    throw err;
  }
  const style = detectJsonStyle(raw.trim() === "" ? "" : raw);

  // An empty or whitespace-only file is treated as {} rather than a parse
  // failure: Claude Code tolerates it, and routing to Repair would be noise.
  if (raw.trim() === "") return { status: "ok", value: {}, existed: true, style };

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
    return { status: "ok", value: parsed as Record<string, unknown>, existed: true, style };
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

export function findFencedBlock(
  text: string,
  id: string,
): { start: number; end: number; body: string } | null {
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
  /**
   * sha256 of the file's bytes right after this change (null: no file). Undo
   * restores a whole-file snapshot, so it must first know nothing else has
   * written the file since, or it would throw that work away.
   */
  afterHash?: string | null;
}

export type WriteFailure =
  | { reason: "unparseable"; failure: ParseFailure }
  | { reason: "invalid"; filePath: string; issues: Array<{ path: string; message: string }> }
  | { reason: "verify-failed"; filePath: string; message: string }
  | { reason: "conflict"; filePath: string; message: string }
  | { reason: "error"; filePath: string; message: string };

/**
 * Thrown from a patchJson mutate when the file holds something that isn't
 * ours to change (a user's own entry under the name a kit wants). The
 * transaction rolls back and reports it as a conflict, not a crash.
 */
export class WriteConflict extends Error {}

export interface TransactionMeta {
  kind: string;
  id: string;
  label: string;
  /**
   * The project folder, when the transaction writes into one. A file under
   * it that is really a symlink (or sits in a symlinked folder) pointing
   * outside it is refused: a repository could commit
   * .claude/settings.json -> ../../../.claude/settings.json and have a
   * "this project" change land in the user's own settings.
   */
  projectDir?: string;
}

export interface TransactionResult {
  ok: boolean;
  changes: RecordedChange[];
  failure?: WriteFailure;
  /** True when rollback itself could not fully restore the disk. */
  rollbackIncomplete?: boolean;
}

/** Applies one operation, returning the change record needed to reverse it. */
function applyOperation(
  op: Operation,
): { ok: true; change: RecordedChange } | { ok: false; failure: WriteFailure } {
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

      // ~/.claude.json belongs to Claude Code, which rewrites it while it runs.
      // Our read-mutate-rename would silently drop anything it wrote in
      // between, so remember what we read and refuse the write if it moved.
      const fingerprintAtRead = fileFingerprint(op.filePath);

      // 3. Snapshot raw bytes before any mutation.
      const backupPath = snapshot(op.filePath);

      // 4. Mutate in memory — only the keys this operation owns.
      // Problems already in the file (an env value written as a number, say)
      // are noted first: they aren't this write's doing, and refusing every
      // change over a key ccpanel never touches would lock the user out.
      const issuesBefore = issueKeys(validateByFilename(op.filePath, read.value).issues);
      const before = structuredClone(getAtPath(read.value, op.keyPath));
      op.mutate(read.value);
      const after = structuredClone(getAtPath(read.value, op.keyPath));

      // 5. Validate. Only problems this change introduces abort the write;
      // nothing has been written yet.
      const introduced = validateByFilename(op.filePath, read.value).issues.filter(
        (issue) => !issuesBefore.has(issueKey(issue)),
      );
      if (introduced.length > 0) {
        return {
          ok: false,
          failure: { reason: "invalid", filePath: op.filePath, issues: introduced },
        };
      }

      // 6 & 7. Serialize the caller's object (never schema output) and rename.
      // Last check before the rename: if someone else wrote the file while we
      // were working, abort rather than overwrite their change. This narrows
      // the race to the microseconds between here and rename(); it cannot
      // close it, because §12.5 rules out holding a lock.
      if (fileFingerprint(op.filePath) !== fingerprintAtRead) {
        return {
          ok: false,
          failure: {
            reason: "conflict",
            filePath: op.filePath,
            message:
              "Something else changed this file while ccpanel was working on it, so nothing was written. This usually means Claude Code is running. Try again.",
          },
        };
      }
      const serialized = serializeJson(read.value, read.style);
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
      // The block is already there (set up before, or from a copy of this
      // project): that's the outcome asked for, so it's done, not a conflict.
      // Its text is left alone in case the user has edited it. Nothing is
      // written, so there is nothing to back up or undo.
      if (findFencedBlock(existing, op.blockId)) {
        return {
          ok: true,
          change: {
            file: op.filePath,
            op: "append-block",
            key: op.blockId,
            backupPath: null,
            existedBefore: true,
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
        change: {
          file: op.filePath,
          op: "append-block",
          key: op.blockId,
          backupPath,
          existedBefore: existed,
        },
      };
    }

    case "removeBlock": {
      if (!fs.existsSync(op.filePath)) {
        return {
          ok: true,
          change: {
            file: op.filePath,
            op: "remove-block",
            key: op.blockId,
            backupPath: null,
            existedBefore: false,
          },
        };
      }
      const existing = fs.readFileSync(op.filePath, "utf8");
      const found = findFencedBlock(existing, op.blockId);
      if (!found) {
        return {
          ok: true,
          change: {
            file: op.filePath,
            op: "remove-block",
            key: op.blockId,
            backupPath: null,
            existedBefore: true,
          },
        };
      }
      const backupPath = snapshot(op.filePath);
      // Removes exactly the fenced region, so text above and below survives.
      const head = existing.slice(0, found.start).replace(/\n+$/, "\n");
      const tail = existing.slice(found.end).replace(/^\n+/, "");
      const next = `${head}${tail}`;
      atomicWriteFile(op.filePath, next);
      return {
        ok: true,
        change: {
          file: op.filePath,
          op: "remove-block",
          key: op.blockId,
          backupPath,
          existedBefore: true,
        },
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

function issueKey(issue: { path: string; message: string }): string {
  return `${issue.path}\u0000${issue.message}`;
}

function issueKeys(issues: Array<{ path: string; message: string }>): Set<string> {
  return new Set(issues.map(issueKey));
}

/** A refused write, in words that name the file and the exact entry. */
export function describeInvalid(failure: {
  filePath: string;
  issues: Array<{ path: string; message: string }>;
}): string {
  const first = failure.issues[0];
  const where = first ? ` at "${first.path}" (${first.message})` : "";
  return `That change would have left ${path.basename(failure.filePath)} with a value Claude Code doesn't accept${where}, so nothing was changed.`;
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

  if (meta.projectDir) {
    for (const op of ops) {
      const realPlace = escapesProject(op.filePath, meta.projectDir);
      if (realPlace) {
        return {
          ok: false,
          changes: [],
          failure: {
            reason: "conflict",
            filePath: op.filePath,
            message: `${path.basename(op.filePath)} in this project is a link to ${realPlace}, which is outside the project, so ccpanel left it alone.`,
          },
        };
      }
    }
  }

  for (const op of ops) {
    let result: ReturnType<typeof applyOperation>;
    try {
      result = applyOperation(op);
    } catch (err) {
      result = {
        ok: false,
        failure: {
          reason: err instanceof WriteConflict ? "conflict" : "error",
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

    result.change.afterHash = contentHash(result.change.file);
    applied.push(result.change);
  }

  // A personal settings file ccpanel just created would otherwise show up in
  // `git status`, one `git add .` away from being committed for everyone.
  if (meta.projectDir) {
    const localSettings = path.join(
      path.resolve(meta.projectDir),
      ".claude",
      "settings.local.json",
    );
    for (const change of applied) {
      if (!change.existedBefore && path.resolve(change.file) === localSettings) {
        ensureGitExcluded(localSettings);
      }
    }
  }

  // 9. Record the whole install as one undo entry.
  recordUndo?.(meta, applied);
  return { ok: true, changes: applied };
}

/** sha256 of a file's bytes, or null when there is no file. */
export function contentHash(filePath: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * The files that are no longer as the recorded changes left them. Only the
 * last change to each file says what it should look like now. A change
 * logged before hashes were recorded can't be checked, so it counts as
 * changed: guessing would risk the user's later work.
 */
export function filesChangedSince(changes: RecordedChange[]): string[] {
  const last = new Map<string, RecordedChange>();
  for (const change of changes) last.set(change.file, change);
  const changed: string[] = [];
  for (const [file, change] of last) {
    if (change.afterHash === undefined || contentHash(file) !== change.afterHash) {
      changed.push(file);
    }
  }
  return changed;
}

/**
 * Reverses a previously recorded set of changes (the Undo screen's engine).
 *
 * Reversing restores whole-file snapshots, so it refuses outright, touching
 * nothing, when any of the files has been written since: by Claude Code, by
 * the user, or by a later ccpanel change.
 */
export function revertChanges(changes: RecordedChange[]): {
  ok: boolean;
  failed: string[];
  changedSince?: string[];
} {
  const changedSince = filesChangedSince(changes);
  if (changedSince.length > 0) return { ok: false, failed: changedSince, changedSince };

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
