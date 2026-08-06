import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepStaleTempFiles } from "../src/core/write.js";

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-sweep-"));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** A pid that is real but certainly not running. */
function deadPid(): number {
  // 0 and 1 are never valid targets for this; pick a high pid and confirm.
  for (let pid = 4_000_000; pid < 4_000_050; pid++) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("could not find a dead pid for the test");
}

describe("stale temp file sweep", () => {
  it("removes temp files left by a crashed ccpanel process", () => {
    const stale = path.join(workDir, `.settings.json.ccpanel.${deadPid()}-abc12345.tmp`);
    fs.writeFileSync(stale, "partial");

    const removed = sweepStaleTempFiles(workDir);

    expect(removed).toHaveLength(1);
    expect(fs.existsSync(stale)).toBe(false);
  });

  it("leaves a live process's in-flight temp file alone", () => {
    const live = path.join(workDir, `.settings.json.ccpanel.${process.pid}-abc12345.tmp`);
    fs.writeFileSync(live, "in flight");

    sweepStaleTempFiles(workDir);

    expect(fs.existsSync(live)).toBe(true);
  });

  it("never touches the user's own files", () => {
    const realFile = path.join(workDir, "settings.json");
    const unrelatedTmp = path.join(workDir, "notes.tmp");
    fs.writeFileSync(realFile, "{}");
    fs.writeFileSync(unrelatedTmp, "mine");

    sweepStaleTempFiles(workDir);

    expect(fs.existsSync(realFile)).toBe(true);
    expect(fs.existsSync(unrelatedTmp)).toBe(true);
  });

  it("returns nothing for a directory that doesn't exist", () => {
    expect(sweepStaleTempFiles(path.join(workDir, "nope"))).toEqual([]);
  });
});
