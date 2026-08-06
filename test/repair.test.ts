import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePaths } from "../src/core/paths.js";
import { checkConfigFiles, findRestoreCandidates, hasProblems, restoreFromBackup } from "../src/core/repair.js";
import { serializeJson, snapshot } from "../src/core/write.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedirMock = vi.fn(actual.homedir);
  return { ...actual, homedir: homedirMock, default: { ...actual, homedir: homedirMock } };
});

let workDir: string;
let fakeHome: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-repair-"));
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-home-"));
  vi.mocked(os.homedir).mockReturnValue(fakeHome);
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

describe("config health check (§10.8)", () => {
  it("reports a clean project as having no problems", () => {
    fs.mkdirSync(path.join(workDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(workDir, ".claude", "settings.json"), serializeJson({ permissions: { allow: [] } }));
    const statuses = checkConfigFiles(resolvePaths(workDir));
    expect(hasProblems(statuses)).toBe(false);
  });

  it("reports a broken file with its parse error and line number", () => {
    fs.mkdirSync(path.join(workDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(workDir, ".claude", "settings.json"), '{\n  "a": 1,\n  "b": 2,\n}\n');

    const statuses = checkConfigFiles(resolvePaths(workDir));
    const broken = statuses.find((s) => s.health === "broken");

    expect(broken).toBeDefined();
    expect(broken?.line).toBe(4);
    expect(hasProblems(statuses)).toBe(true);
  });

  it("distinguishes a missing file from a broken one", () => {
    const statuses = checkConfigFiles(resolvePaths(workDir));
    expect(statuses.every((s) => s.health === "missing" || s.health === "ok")).toBe(true);
    expect(hasProblems(statuses)).toBe(false);
  });

  it("flags a schema-violating but parseable file as questionable, not broken", () => {
    fs.mkdirSync(path.join(workDir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, ".claude", "settings.json"),
      serializeJson({ skillOverrides: { deploy: "maybe" } }),
    );
    const statuses = checkConfigFiles(resolvePaths(workDir));
    const flagged = statuses.find((s) => s.health === "questionable");
    expect(flagged).toBeDefined();
    expect(hasProblems(statuses)).toBe(false);
  });

  it("treats an empty settings file as fine", () => {
    fs.mkdirSync(path.join(workDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(workDir, ".claude", "settings.json"), "");
    expect(hasProblems(checkConfigFiles(resolvePaths(workDir)))).toBe(false);
  });

  it("never exposes a raw file path as the user-facing name", () => {
    for (const status of checkConfigFiles(resolvePaths(workDir))) {
      expect(status.plainName).not.toContain("/");
      expect(status.plainName).not.toContain(".json");
    }
  });
});

describe("restore candidates", () => {
  it("finds our own snapshots, newest first", async () => {
    const target = path.join(workDir, "settings.json");
    fs.writeFileSync(target, serializeJson({ v: 1 }));
    snapshot(target);
    await new Promise((r) => setTimeout(r, 5));
    fs.writeFileSync(target, serializeJson({ v: 2 }));
    snapshot(target);

    const candidates = findRestoreCandidates(target);
    expect(candidates.length).toBe(2);
    expect(candidates.every((c) => c.source === "ccpanel")).toBe(true);
    expect(JSON.parse(fs.readFileSync(candidates[0]!.backupPath, "utf8"))).toEqual({ v: 2 });
  });

  it("finds Claude Code's own rotating backups by their unix-ms naming", () => {
    const ccBackups = path.join(fakeHome, ".claude", "backups");
    fs.mkdirSync(ccBackups, { recursive: true });
    fs.writeFileSync(path.join(ccBackups, ".claude.json.backup.1785994762866"), serializeJson({ from: "cc" }));

    const candidates = findRestoreCandidates(path.join(fakeHome, ".claude.json"));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.source).toBe("claude-code");
    expect(candidates[0]?.takenAt?.getTime()).toBe(1785994762866);
  });

  it("returns nothing rather than throwing when no backups exist", () => {
    expect(findRestoreCandidates(path.join(workDir, "never-seen.json"))).toEqual([]);
  });
});

describe("restoring", () => {
  it("restores a good backup over a broken file and snapshots the broken one first", () => {
    const target = path.join(workDir, "settings.json");
    fs.writeFileSync(target, serializeJson({ permissions: { allow: ["Bash(ls)"] } }));
    const backup = snapshot(target) as string;

    fs.writeFileSync(target, "{ broken,,, ");
    const result = restoreFromBackup(backup, target);

    expect(result.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ permissions: { allow: ["Bash(ls)"] } });
    expect(result.backupOfBroken).not.toBeNull();
    expect(fs.readFileSync(result.backupOfBroken as string, "utf8")).toBe("{ broken,,, ");
  });

  it("refuses to restore a backup that is itself damaged", () => {
    const target = path.join(workDir, "settings.json");
    fs.writeFileSync(target, serializeJson({ ok: true }));
    const badBackup = path.join(workDir, "bad.json");
    fs.writeFileSync(badBackup, "{ also broken,,,");

    const result = restoreFromBackup(badBackup, target);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("older");
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ ok: true });
  });
});
