import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Running other programs, and finding one on PATH without running it. Part of core/updates.ts — see the overview there. */

// ---------------------------------------------------------------------------
// Running other programs
// ---------------------------------------------------------------------------

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Extra environment variables, laid over the current environment. */
  env?: Record<string, string>;
}

export interface ExecResult {
  ok: boolean;
  /** Process exit code, or null when it never got that far. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Why it failed. "missing" is normal — the tool simply isn't installed. */
  failure: "missing" | "timeout" | "error" | null;
}

/**
 * Every child process goes through this shape: an argv array, never a string
 * handed to a shell, so a skill directory named `; rm -rf ~` is just a
 * directory name. Injectable so tests can answer without running anything.
 */
export type ExecRunner = (
  file: string,
  args: readonly string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

/** Long enough for a cold `--version`, short enough not to hang the screen. */
export const DEFAULT_TIMEOUT_MS = 4_000;
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export const defaultExec: ExecRunner = (file, args, options = {}) =>
  new Promise<ExecResult>((resolve) => {
    execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : undefined,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, code: 0, stdout, stderr, failure: null });
          return;
        }
        const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
        // A command that isn't installed is an ordinary answer here, not a
        // crash — plenty of skills reference a tool the user never installed.
        const failure: ExecResult["failure"] =
          err.code === "ENOENT"
            ? "missing"
            : err.killed === true || err.signal
              ? "timeout"
              : "error";
        resolve({
          ok: false,
          code: typeof err.code === "number" ? err.code : null,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          failure,
        });
      },
    );
  });

// ---------------------------------------------------------------------------
// Finding a command without running one
// ---------------------------------------------------------------------------

/** Command names we are willing to look for: no slashes, no `..`, no tricks. */
export const SAFE_COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Walks PATH itself instead of shelling out to `which`. The name comes from a
 * file inside a skill directory, so it is checked against a strict pattern
 * before being joined onto anything.
 */
export function findOnPath(
  command: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (!SAFE_COMMAND_NAME.test(command) || command.includes("..")) return null;
  const raw = env["PATH"] ?? "";
  for (const dir of raw.split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, command);
    try {
      if (!fs.statSync(candidate).isFile()) continue; // statSync follows the usual symlink shims
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not in this directory
    }
  }
  return null;
}
