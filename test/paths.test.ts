import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getClaudePaths, resolvePaths } from "../src/core/paths.js";

// vi.spyOn on the default import doesn't intercept `paths.ts`'s separately
// bound `import { homedir } from "node:os"` under esbuild's transform —
// vi.mock replaces the module registration itself, which both import styles
// resolve against.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedirMock = vi.fn(actual.homedir);
  return { ...actual, homedir: homedirMock, default: { ...actual, homedir: homedirMock } };
});

describe("resolvePaths", () => {
  let tmpRoot: string;
  let fakeHome: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-test-"));
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-home-"));
    vi.mocked(os.homedir).mockReturnValue(fakeHome);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it("resolves the git root through nested subdirectories, not the launch dir (acceptance test #7)", () => {
    const repoDir = path.join(tmpRoot, "repo");
    const nested = path.join(repoDir, "src", "deep", "nested");
    fs.mkdirSync(nested, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repoDir });

    const info = resolvePaths(nested);
    expect(info.isGitRepo).toBe(true);
    expect(info.gitRoot).toBe(fs.realpathSync(repoDir));
    expect(info.projectDir).toBe(info.gitRoot);

    const claudePaths = getClaudePaths(info);
    expect(claudePaths.projectSettings).toBe(path.join(fs.realpathSync(repoDir), ".claude", "settings.json"));
    expect(claudePaths.localSettings.startsWith(fs.realpathSync(nested))).toBe(false);
  });

  it("builds the ancestor chain from the repo root down to cwd, inclusive", () => {
    const repoDir = path.join(tmpRoot, "repo2");
    const nested = path.join(repoDir, "src", "deep");
    fs.mkdirSync(nested, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repoDir });

    const info = resolvePaths(nested);
    expect(info.ancestorDirs[0]).toBe(fs.realpathSync(repoDir));
    expect(info.ancestorDirs.at(-1)).toBe(fs.realpathSync(nested));
    expect(info.ancestorDirs).toEqual([
      fs.realpathSync(repoDir),
      path.join(fs.realpathSync(repoDir), "src"),
      fs.realpathSync(nested),
    ]);
  });

  it("falls back to cwd outside a git repo", () => {
    const plainDir = path.join(tmpRoot, "plain");
    fs.mkdirSync(plainDir, { recursive: true });

    const info = resolvePaths(plainDir);
    expect(info.isGitRepo).toBe(false);
    expect(info.gitRoot).toBeNull();
    expect(info.projectDir).toBe(fs.realpathSync(plainDir));
  });

  it("treats a repo root equal to the home directory as not a real project root", () => {
    execFileSync("git", ["init", "-q"], { cwd: fakeHome });

    const info = resolvePaths(fakeHome);
    expect(info.isGitRepo).toBe(false);
    expect(info.gitRoot).toBeNull();
    expect(info.projectDir).toBe(fs.realpathSync(fakeHome));
  });
});
