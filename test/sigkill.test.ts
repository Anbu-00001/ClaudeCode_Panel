import { execFileSync, fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Acceptance test #3: SIGKILL mid-write, twenty times in a loop. The target
 * file must always be complete-old or complete-new, never truncated.
 *
 * This runs against the compiled output in a real child process — the whole
 * point is an abrupt kill the process cannot handle, which can't be simulated
 * in-process.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const childScript = path.join(here, "fixtures", "write-loop.mjs");
const distWrite = path.join(projectRoot, "dist", "core", "write.js");

let workDir: string;
let fakeHome: string;

beforeAll(() => {
  execFileSync("npx", ["tsc", "-p", "tsconfig.json"], { cwd: projectRoot, stdio: "pipe" });
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-sigkill-"));
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-kill-home-"));
}, 120_000);

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

function killMidWrite(target: string, afterMs: number): Promise<void> {
  return new Promise((resolve) => {
    const child = fork(childScript, [pathToFileURL(distWrite).href, target], {
      env: { ...process.env, HOME: fakeHome },
      stdio: "ignore",
    });

    let killed = false;
    let killTimer: NodeJS.Timeout | undefined;

    // The kill timer must not start until the child is actually writing.
    // Loading the module graph takes longer than the kill delay, so timing
    // from spawn would kill it during import and the test would pass
    // trivially without ever exercising a partial write.
    child.on("message", (msg) => {
      if (msg !== "ready" || killTimer) return;
      killTimer = setTimeout(() => {
        killed = true;
        child.kill("SIGKILL");
      }, afterMs);
    });

    child.on("exit", () => {
      if (killTimer) clearTimeout(killTimer);
      if (!killed) child.kill("SIGKILL");
      resolve();
    });
  });
}

describe("crash safety (acceptance #3)", () => {
  it("never leaves a truncated file across 20 SIGKILLs mid-write", async () => {
    const target = path.join(workDir, "settings.json");

    for (let round = 0; round < 20; round++) {
      // Vary the kill moment so it lands at different points inside a write.
      const delay = 30 + ((round * 7) % 60);
      await killMidWrite(target, delay);

      if (!fs.existsSync(target)) continue; // killed before the first rename

      const raw = fs.readFileSync(target, "utf8");
      let parsed: { version?: number; filler?: string };
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new Error(
          `Round ${round}: target file was truncated (${raw.length} bytes): ${(err as Error).message}`,
        );
      }

      // A complete payload, not a half-written one.
      expect([1, 2]).toContain(parsed.version);
      expect(parsed.filler?.length).toBe(120_000);
      expect(raw.endsWith("\n")).toBe(true);
    }
  }, 120_000);
});
