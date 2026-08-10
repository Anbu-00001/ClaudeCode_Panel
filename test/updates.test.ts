import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePaths } from "../src/core/paths.js";
import { type SkillInfo, listSkills } from "../src/core/skills.js";
import {
  type ExecOptions,
  type ExecResult,
  type ExecRunner,
  type GitUpdateCheck,
  type ManualUpdateCheck,
  type PluginUpdateCheck,
  type ToolUpdateCheck,
  checkSkillUpdate,
  compareVersions,
  extractVersion,
  fetchGitRemote,
  findOnPath,
  findSelfUpdateSubcommand,
  findSkillRepoRoot,
  findVersionMarker,
  listSkillUpdates,
  summarizeUpdates,
} from "../src/core/updates.js";

/**
 * A test in this repo once wrote into the developer's real home directory.
 * Nothing here reads or writes anything outside a temp dir: every check gets
 * an injected `home`, an injected `PATH`, and an injected exec runner, so no
 * child process is ever spawned and the real ~/.claude is never opened.
 * `os.homedir` is mocked as a second line of defence for the one test that
 * goes through listSkills, which reads the home directory on its own.
 */
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedirMock = vi.fn(actual.homedir);
  return { ...actual, homedir: homedirMock, default: { ...actual, homedir: homedirMock } };
});

const REAL_HOME = path.resolve(process.env["HOME"] ?? "/nonexistent-home");

let work: string;
let fakeHome: string;
let fakeBin: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-upd-"));
  fakeHome = path.join(work, "home");
  fakeBin = path.join(work, "bin");
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  vi.mocked(os.homedir).mockReturnValue(fakeHome);
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// --- helpers ---------------------------------------------------------------

const NOW = new Date("2026-08-10T12:00:00Z");

/** No PATH at all, so nothing is ever "found" unless a test puts it there. */
const emptyEnv: Record<string, string | undefined> = { PATH: "" };
const binEnv = (): Record<string, string | undefined> => ({ PATH: fakeBin });

type Reply = string | Partial<ExecResult> | null;

interface Stub {
  exec: ExecRunner;
  calls: { file: string; args: string[]; options?: ExecOptions }[];
}

/** Answers commands from a table. Nothing is spawned; nothing can mutate. */
function makeExec(handler: (file: string, args: string[]) => Reply): Stub {
  const calls: Stub["calls"] = [];
  const exec: ExecRunner = async (file, args, options) => {
    calls.push({ file, args: [...args], ...(options ? { options } : {}) });
    const reply = handler(file, [...args]);
    if (reply === null) {
      return { ok: false, code: 1, stdout: "", stderr: "", failure: "error" };
    }
    if (typeof reply === "string") {
      return { ok: true, code: 0, stdout: reply, stderr: "", failure: null };
    }
    return {
      ok: reply.ok ?? true,
      code: reply.code ?? 0,
      stdout: reply.stdout ?? "",
      stderr: reply.stderr ?? "",
      failure: reply.failure ?? null,
    };
  };
  return { exec, calls };
}

/** An exec runner that fails the test if anything tries to run at all. */
const forbiddenExec: ExecRunner = async (file, args) => {
  throw new Error(`test tried to run: ${file} ${args.join(" ")}`);
};

function makeSkillDir(parent: string, name: string): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: does things\n---\n`);
  return dir;
}

function skillAt(dir: string, overrides: Partial<SkillInfo> = {}): SkillInfo {
  return {
    name: path.basename(dir),
    description: "does things",
    source: "user",
    filePath: path.join(dir, "SKILL.md"),
    pluginId: null,
    switchable: true,
    disablesModelInvocation: false,
    userInvocable: true,
    weight: "a little",
    descriptionChars: 11,
    ...overrides,
  };
}

/** A file with the executable bit, which is all findOnPath looks for. */
function putOnPath(name: string): string {
  const file = path.join(fakeBin, name);
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(file, 0o755);
  return file;
}

function writePluginState(options: {
  pluginId: string;
  installedVersion?: string | null;
  installPath?: string;
  catalogVersion?: string | null;
  catalogName?: string | null;
  marketplace?: string;
}): void {
  const marketplace = options.marketplace ?? "some-marketplace";
  const pluginsDir = path.join(fakeHome, ".claude", "plugins");
  const marketplaceDir = path.join(pluginsDir, "marketplaces", marketplace, ".claude-plugin");
  fs.mkdirSync(marketplaceDir, { recursive: true });

  const install: Record<string, unknown> = {
    scope: "user",
    installPath: options.installPath ?? path.join(pluginsDir, "cache", "x"),
    installedAt: "2026-08-01T00:00:00.000Z",
    lastUpdated: "2026-08-03T00:00:00.000Z",
  };
  if (options.installedVersion !== null) install["version"] = options.installedVersion ?? "1.0.0";

  fs.writeFileSync(
    path.join(pluginsDir, "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { [options.pluginId]: [install] } }),
  );
  fs.writeFileSync(
    path.join(pluginsDir, "known_marketplaces.json"),
    JSON.stringify({
      [marketplace]: { installLocation: path.join(pluginsDir, "marketplaces", marketplace) },
    }),
  );

  const entry: Record<string, unknown> = {
    name: options.catalogName ?? options.pluginId.split("@")[0],
    description: "a bundle",
    source: { source: "git-subdir", url: "https://example.invalid/x.git", ref: "v9.9.9" },
  };
  if (options.catalogVersion) entry["version"] = options.catalogVersion;
  fs.writeFileSync(
    path.join(marketplaceDir, "marketplace.json"),
    JSON.stringify({ name: marketplace, plugins: [entry] }),
  );
}

// --- version comparison ----------------------------------------------------

describe("comparing versions without a dependency", () => {
  it("orders by number, not by string", () => {
    // The classic: "1.10.0" < "1.9.0" alphabetically, and the opposite in fact.
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.9.0", "1.10.0")).toBe(-1);
    expect(compareVersions("0.9.32", "0.9.9")).toBe(1);
    expect(compareVersions("2.0.0", "10.0.0")).toBe(-1);
  });

  it("ignores a v prefix on either side", () => {
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("V2.0.0", "v1.9.9")).toBe(1);
  });

  it("treats missing trailing parts as zero", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1", "1.0.0.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.1")).toBe(-1);
  });

  it("ranks a prerelease below the release it leads to", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.2")).toBe(-1);
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-beta")).toBe(-1);
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.10")).toBe(-1);
    expect(compareVersions("1.0.0-beta", "1.0.0-beta")).toBe(0);
  });

  it("ignores build metadata", () => {
    expect(compareVersions("1.0.0+build.7", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0+a", "1.0.0+b")).toBe(0);
  });

  it("returns unknown for anything that isn't a version", () => {
    for (const junk of ["", "   ", "latest", "main", "HEAD", "1.x", "v", "1.0.0-", "abc.def", "e3f9a1c"]) {
      expect(compareVersions(junk, "1.0.0"), junk).toBeNull();
      expect(compareVersions("1.0.0", junk), junk).toBeNull();
    }
  });
});

describe("reading a version out of command output", () => {
  it("finds the version in a one-line banner", () => {
    expect(extractVersion("sometool 0.9.32")).toBe("0.9.32");
    expect(extractVersion("git version 2.43.0")).toBe("2.43.0");
    expect(extractVersion("v1.2.3\n")).toBe("1.2.3");
    expect(extractVersion("  1.0.0-rc.1  ")).toBe("1.0.0-rc.1");
    expect(extractVersion("thing version v10.4.1 (build abc123)")).toBe("10.4.1");
  });

  it("skips lines with no version in them", () => {
    expect(extractVersion("warning: config missing\nsometool 3.4.5")).toBe("3.4.5");
  });

  it("returns null when there is no version to find", () => {
    expect(extractVersion("")).toBeNull();
    expect(extractVersion("no idea, sorry")).toBeNull();
    expect(extractVersion("released 2026-08-10")).toBeNull();
  });
});

// --- PATH lookup -----------------------------------------------------------

describe("finding a command on PATH", () => {
  it("finds an executable file", () => {
    const file = putOnPath("sometool");
    expect(findOnPath("sometool", binEnv())).toBe(file);
  });

  it("returns null when the command isn't there", () => {
    expect(findOnPath("sometool", binEnv())).toBeNull();
    expect(findOnPath("sometool", emptyEnv)).toBeNull();
    expect(findOnPath("sometool", {})).toBeNull();
  });

  it("ignores a directory of the same name", () => {
    fs.mkdirSync(path.join(fakeBin, "sometool"));
    expect(findOnPath("sometool", binEnv())).toBeNull();
  });

  it("refuses a name that isn't a bare command", () => {
    // The name comes out of a file in a skill dir, so it is never joined blindly.
    for (const evil of ["../evil", "a/b", "", ".", "..", "../../bin/sh", "-rf"]) {
      expect(findOnPath(evil, binEnv()), evil).toBeNull();
    }
  });
});

// --- help parsing ----------------------------------------------------------

describe("only suggesting a command the tool admits to having", () => {
  it("finds a self-update subcommand", () => {
    const help = ["Usage: sometool <command>", "", "Commands:", "  self-update      update sometool itself", "  build            build things"].join("\n");
    expect(findSelfUpdateSubcommand(help)).toBe("self-update");
  });

  it("prefers the most explicit wording", () => {
    const help = ["  update [pkg]   update packages", "  upgrade        upgrade sometool", "  self-update    update sometool"].join("\n");
    expect(findSelfUpdateSubcommand(help)).toBe("self-update");
    expect(findSelfUpdateSubcommand("  update [pkg]  update packages\n  upgrade   upgrade sometool")).toBe("upgrade");
  });

  it("rejects an update subcommand that acts on an argument, not on itself", () => {
    // Real case: a tool whose `update <path>` rebuilds a file you hand it.
    // Running that as a self-update would do something entirely unrelated.
    const help = [
      "Usage: sometool <command>",
      "",
      "Commands:",
      "  watch <path>            watch a folder and rebuild on changes",
      "  update <path>           re-extract files and update the output",
      "    --force                 overwrite even if smaller",
    ].join("\n");
    expect(findSelfUpdateSubcommand(help)).toBeNull();
  });

  it("accepts an optional argument", () => {
    expect(findSelfUpdateSubcommand("  update [channel]   update sometool")).toBe("update");
    expect(findSelfUpdateSubcommand("  update")).toBe("update");
  });

  it("doesn't mistake prose for a subcommand", () => {
    const help = ["Usage: sometool", "", "Run this often to update the graph and keep it current.", "upgrade your plan at example.invalid"].join("\n");
    expect(findSelfUpdateSubcommand(help)).toBeNull();
  });

  it("returns null for help that offers nothing", () => {
    expect(findSelfUpdateSubcommand("")).toBeNull();
    expect(findSelfUpdateSubcommand("Usage: sometool [options]\n  --verbose   say more")).toBeNull();
  });
});

// --- plugin ----------------------------------------------------------------

describe("a skill from an installed bundle", () => {
  function pluginSkill(installPath: string, pluginId: string): SkillInfo {
    const dir = makeSkillDir(path.join(installPath, "skills"), "bundled");
    return skillAt(dir, { source: "plugin", pluginId, switchable: false });
  }

  it("is behind when the catalogue lists a newer version", async () => {
    const installPath = path.join(fakeHome, ".claude", "plugins", "cache", "thing", "1.0.0");
    writePluginState({ pluginId: "thing@some-marketplace", installedVersion: "1.0.0", installPath, catalogVersion: "1.2.0" });
    putOnPath("claude");

    const check = (await checkSkillUpdate(pluginSkill(installPath, "thing@some-marketplace"), {
      home: fakeHome, env: binEnv(), exec: forbiddenExec, now: NOW,
    })) as PluginUpdateCheck;

    expect(check.method).toBe("plugin");
    expect(check.status).toBe("behind");
    expect(check.installedVersion).toBe("1.0.0");
    expect(check.catalogVersion).toBe("1.2.0");
    expect(check.command?.argv).toEqual(["claude", "plugin", "update", "thing@some-marketplace"]);
    expect(check.command?.needsRestart).toBe(true);
  });

  it("is up to date when the two versions match", async () => {
    const installPath = path.join(fakeHome, ".claude", "plugins", "cache", "thing", "2.0.6");
    writePluginState({ pluginId: "thing@some-marketplace", installedVersion: "2.0.6", installPath, catalogVersion: "2.0.6" });
    putOnPath("claude");

    const check = await checkSkillUpdate(pluginSkill(installPath, "thing@some-marketplace"), {
      home: fakeHome, env: binEnv(), exec: forbiddenExec, now: NOW,
    });

    expect(check.status).toBe("up-to-date");
    expect(check.detail).toContain("2.0.6");
  });

  it("is unknown — never up to date — when the catalogue publishes no version", async () => {
    // Most real catalogue entries have no version field at all. Staleness is
    // genuinely unknowable there, and saying "up to date" would be a lie.
    const installPath = path.join(fakeHome, ".claude", "plugins", "cache", "thing", "1.0.0");
    writePluginState({ pluginId: "thing@some-marketplace", installedVersion: "1.0.0", installPath, catalogVersion: null });

    const check = (await checkSkillUpdate(pluginSkill(installPath, "thing@some-marketplace"), {
      home: fakeHome, env: emptyEnv, exec: forbiddenExec, now: NOW,
    })) as PluginUpdateCheck;

    expect(check.status).toBe("unknown");
    expect(check.catalogVersion).toBeNull();
    expect(check.summary.toLowerCase()).not.toContain("up to date");
    expect(check.detail).toContain("doesn't publish a version");
  });

  it("shows the catalogue's git ref but never judges staleness by it", async () => {
    const installPath = path.join(fakeHome, ".claude", "plugins", "cache", "thing", "1.0.0");
    writePluginState({ pluginId: "thing@some-marketplace", installedVersion: "1.0.0", installPath, catalogVersion: null });

    const check = (await checkSkillUpdate(pluginSkill(installPath, "thing@some-marketplace"), {
      home: fakeHome, env: emptyEnv, exec: forbiddenExec, now: NOW,
    })) as PluginUpdateCheck;

    expect(check.catalogRef).toBe("v9.9.9");
    expect(check.status).toBe("unknown");
  });

  it("is unknown when the catalogue has no entry for the bundle at all", async () => {
    const installPath = path.join(fakeHome, ".claude", "plugins", "cache", "thing", "1.0.0");
    writePluginState({ pluginId: "thing@some-marketplace", installedVersion: "1.0.0", installPath, catalogVersion: "5.0.0", catalogName: "something-else" });

    const check = await checkSkillUpdate(pluginSkill(installPath, "thing@some-marketplace"), {
      home: fakeHome, env: emptyEnv, exec: forbiddenExec, now: NOW,
    });

    expect(check.status).toBe("unknown");
    expect(check.detail).toContain("no entry");
  });

  it("offers no command when the claude CLI isn't installed", async () => {
    const installPath = path.join(fakeHome, ".claude", "plugins", "cache", "thing", "1.0.0");
    writePluginState({ pluginId: "thing@some-marketplace", installedVersion: "1.0.0", installPath, catalogVersion: "1.2.0" });

    const check = await checkSkillUpdate(pluginSkill(installPath, "thing@some-marketplace"), {
      home: fakeHome, env: emptyEnv, exec: forbiddenExec, now: NOW,
    });

    expect(check.status).toBe("behind");
    expect(check.command).toBeNull();
  });

  it("reads the injected home and never the real one", async () => {
    // The guard for the bug this repo already had once: point a plugin skill
    // at an id that exists in the developer's real ~/.claude and confirm the
    // empty temp home is what gets read.
    const installPath = path.join(fakeHome, "plugins", "typescript-lsp");
    const check = (await checkSkillUpdate(pluginSkill(installPath, "typescript-lsp@claude-plugins-official"), {
      home: fakeHome, env: emptyEnv, exec: forbiddenExec, now: NOW,
    })) as PluginUpdateCheck;

    expect(check.installedVersion).toBeNull();
    expect(check.detail).toContain("no installation record");
    expect(fs.existsSync(path.join(fakeHome, ".claude", "plugins"))).toBe(false);
    expect(REAL_HOME).not.toBe(fakeHome);
  });
});

// --- git -------------------------------------------------------------------

describe("finding the repository a skill belongs to", () => {
  it("finds a clone that is the skill directory itself", () => {
    const dir = makeSkillDir(work, "cloned");
    fs.mkdirSync(path.join(dir, ".git"));
    expect(findSkillRepoRoot(dir)).toBe(dir);
  });

  it("finds a repo rooted at the .claude directory", () => {
    const claude = path.join(work, "somewhere", ".claude");
    fs.mkdirSync(path.join(claude, ".git"), { recursive: true });
    const dir = makeSkillDir(path.join(claude, "skills"), "dotfiles-skill");
    expect(findSkillRepoRoot(dir)).toBe(claude);
  });

  it("never escapes upward into the user's own project repo", () => {
    // Offering `git pull` on someone's working code as a "skill update" would
    // be the worst bug this module could have.
    const project = path.join(work, "project");
    fs.mkdirSync(path.join(project, ".git"), { recursive: true });
    const dir = makeSkillDir(path.join(project, ".claude", "skills"), "project-skill");
    expect(findSkillRepoRoot(dir)).toBeNull();
  });

  it("returns null for a plain directory", () => {
    expect(findSkillRepoRoot(makeSkillDir(work, "plain"))).toBeNull();
  });
});

describe("a skill that is a git clone", () => {
  function gitDir(name: string, fetchedAt: Date | null): string {
    const dir = makeSkillDir(work, name);
    const dotGit = path.join(dir, ".git");
    fs.mkdirSync(dotGit);
    if (fetchedAt) {
      const head = path.join(dotGit, "FETCH_HEAD");
      fs.writeFileSync(head, "abc123\n");
      fs.utimesSync(head, fetchedAt, fetchedAt);
    }
    return dir;
  }

  function gitExec(answers: { upstream?: string | null; counts?: string; dirty?: string }): Stub {
    return makeExec((file, args) => {
      if (file !== "git") return null;
      const line = args.join(" ");
      if (line.includes("--absolute-git-dir")) {
        const root = args[1] ?? "";
        return path.join(root, ".git");
      }
      if (line.includes("symbolic-full-name")) return answers.upstream ?? null;
      if (line.includes("abbrev-ref HEAD")) return "main";
      if (line.includes("rev-list")) return answers.counts ?? "0\t0";
      if (line.includes("remote.origin.url")) return "https://example.invalid/skill.git";
      if (line.includes("status --porcelain")) return answers.dirty ?? "";
      return null;
    });
  }

  it("reports how many commits behind, from local refs only", async () => {
    const dir = gitDir("clone-behind", new Date(NOW.getTime() - 10 * 60_000));
    const stub = gitExec({ upstream: "origin/main", counts: "2\t0" });

    const check = (await checkSkillUpdate(skillAt(dir), {
      home: fakeHome, env: emptyEnv, exec: stub.exec, now: NOW,
    })) as GitUpdateCheck;

    expect(check.method).toBe("git");
    expect(check.status).toBe("behind");
    expect(check.behind).toBe(2);
    expect(check.ahead).toBe(0);
    expect(check.upstream).toBe("origin/main");
    expect(check.remoteUrl).toBe("https://example.invalid/skill.git");
    expect(check.command?.argv).toEqual(["git", "-C", dir, "pull", "--ff-only"]);
    // C1: a check never touches the network.
    expect(stub.calls.some((c) => c.args.includes("fetch"))).toBe(false);
  });

  it("says where the commit count came from when the remote was never contacted", async () => {
    const dir = gitDir("clone-behind-unfetched", null);
    const check = await checkSkillUpdate(skillAt(dir), {
      home: fakeHome, env: emptyEnv, exec: gitExec({ upstream: "origin/main", counts: "1\t0" }).exec, now: NOW,
    });

    expect(check.status).toBe("behind");
    expect(check.detail).toContain("1 commit behind origin/main");
    expect(check.detail).toContain("never contacted the remote");
    expect(check.detail).not.toContain("last checked");
  });

  it("says up to date only when the local refs are recent", async () => {
    const dir = gitDir("clone-fresh", new Date(NOW.getTime() - 5 * 60_000));
    const check = (await checkSkillUpdate(skillAt(dir), {
      home: fakeHome, env: emptyEnv, exec: gitExec({ upstream: "origin/main", counts: "0\t0" }).exec, now: NOW,
    })) as GitUpdateCheck;

    expect(check.status).toBe("up-to-date");
    expect(check.refsAreFresh).toBe(true);
  });

  it("won't call a stale clone up to date just because it has no new commits", async () => {
    const dir = gitDir("clone-stale", new Date(NOW.getTime() - 30 * 24 * 60 * 60_000));
    const check = (await checkSkillUpdate(skillAt(dir), {
      home: fakeHome, env: emptyEnv, exec: gitExec({ upstream: "origin/main", counts: "0\t0" }).exec, now: NOW,
    })) as GitUpdateCheck;

    expect(check.status).toBe("unknown");
    expect(check.behind).toBe(0);
    expect(check.refsAreFresh).toBe(false);
    expect(check.detail).toContain("30 days ago");
    expect(check.summary.toLowerCase()).not.toContain("up to date");
  });

  it("is unknown when the clone has never contacted a remote", async () => {
    const dir = gitDir("clone-never", null);
    const check = (await checkSkillUpdate(skillAt(dir), {
      home: fakeHome, env: emptyEnv, exec: gitExec({ upstream: "origin/main", counts: "0\t0" }).exec, now: NOW,
    })) as GitUpdateCheck;

    expect(check.status).toBe("unknown");
    expect(check.lastFetchedAt).toBeNull();
    expect(check.detail).toContain("never contacted the remote");
  });

  it("has no update path when the branch follows nothing", async () => {
    const dir = gitDir("clone-detached", null);
    const check = (await checkSkillUpdate(skillAt(dir), {
      home: fakeHome, env: emptyEnv, exec: gitExec({ upstream: null }).exec, now: NOW,
    })) as GitUpdateCheck;

    expect(check.status).toBe("unknown");
    expect(check.upstream).toBeNull();
    expect(check.command).toBeNull();
  });

  it("mentions local commits and uncommitted changes", async () => {
    const dir = gitDir("clone-messy", new Date(NOW.getTime() - 60_000));
    const check = await checkSkillUpdate(skillAt(dir), {
      home: fakeHome, env: emptyEnv,
      exec: gitExec({ upstream: "origin/main", counts: "3\t1", dirty: " M SKILL.md\n" }).exec,
      now: NOW,
    });

    expect(check.detail).toContain("1 local commit");
    expect(check.detail).toContain("uncommitted changes");
  });
});

describe("checking the remote on purpose", () => {
  it("is the one call that touches the network, and reports what it ran", async () => {
    const stub = makeExec(() => "");
    const outcome = await fetchGitRemote("/some/repo", { exec: stub.exec, home: fakeHome, env: emptyEnv });

    expect(outcome.ok).toBe(true);
    expect(outcome.argv).toEqual(["git", "-C", "/some/repo", "fetch", "--quiet"]);
    expect(stub.calls[0]?.args).toEqual(["-C", "/some/repo", "fetch", "--quiet"]);
  });

  it("treats a missing git as an answer, not a crash", async () => {
    const stub = makeExec(() => ({ ok: false, failure: "missing", code: null }));
    const outcome = await fetchGitRemote("/some/repo", { exec: stub.exec, home: fakeHome, env: emptyEnv });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("isn't installed");
  });

  it("passes on what git complained about", async () => {
    const stub = makeExec(() => ({ ok: false, code: 128, stderr: "fatal: could not read from remote\nmore" }));
    const outcome = await fetchGitRemote("/some/repo", { exec: stub.exec, home: fakeHome, env: emptyEnv });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe("fatal: could not read from remote");
  });
});

// --- tool ------------------------------------------------------------------

describe("finding a version marker", () => {
  it("takes the tool name out of the filename", () => {
    const dir = makeSkillDir(work, "marked");
    fs.writeFileSync(path.join(dir, ".sometool_version"), "0.9.32\n");
    const marker = findVersionMarker(dir, "marked");

    expect(marker?.version).toBe("0.9.32");
    expect(marker?.candidates[0]).toBe("sometool");
  });

  it("falls back to the directory name for a generic marker", () => {
    const dir = makeSkillDir(work, "sometool");
    fs.writeFileSync(path.join(dir, "VERSION"), "v2.1.0");
    const marker = findVersionMarker(dir, "sometool");

    expect(marker?.version).toBe("2.1.0");
    expect(marker?.candidates).toContain("sometool");
  });

  it("returns null when there is no marker", () => {
    expect(findVersionMarker(makeSkillDir(work, "bare"), "bare")).toBeNull();
    expect(findVersionMarker(path.join(work, "missing"), "missing")).toBeNull();
  });
});

describe("a skill installed by a tool that is on PATH", () => {
  function markedSkill(toolName: string, markerVersion: string): SkillInfo {
    const dir = makeSkillDir(work, `${toolName}-skill`);
    fs.writeFileSync(path.join(dir, `.${toolName}_version`), `${markerVersion}\n`);
    putOnPath(toolName);
    return skillAt(dir);
  }

  const toolExec = (version: string, help: string): Stub =>
    makeExec((file, args) => {
      if (file !== "sometool") return { ok: false, failure: "missing", code: null };
      if (args[0] === "--version") return `sometool ${version}`;
      if (args[0] === "--help") return help;
      return null;
    });

  it("is behind when the installed tool has moved on", async () => {
    const skill = markedSkill("sometool", "0.9.30");
    const check = (await checkSkillUpdate(skill, {
      home: fakeHome, env: binEnv(), exec: toolExec("0.9.32", "Usage: sometool\n  build   build things").exec, now: NOW,
    })) as ToolUpdateCheck;

    expect(check.method).toBe("tool");
    expect(check.status).toBe("behind");
    expect(check.markerVersion).toBe("0.9.30");
    expect(check.installedToolVersion).toBe("0.9.32");
    expect(check.toolName).toBe("sometool");
    // The tool's help lists nothing that updates it, so nothing is suggested.
    expect(check.command).toBeNull();
    expect(check.detail).toContain("doesn't list a command for updating itself");
  });

  it("offers a command only when the tool's own help lists one", async () => {
    const skill = markedSkill("sometool", "0.9.30");
    const help = "Usage: sometool <command>\n\nCommands:\n  self-update    update sometool in place\n";
    const check = await checkSkillUpdate(skill, {
      home: fakeHome, env: binEnv(), exec: toolExec("0.9.32", help).exec, now: NOW,
    });

    expect(check.command?.argv).toEqual(["sometool", "self-update"]);
    expect(check.command?.needsRestart).toBe(false);
  });

  it("is up to date when the marker matches the tool", async () => {
    const skill = markedSkill("sometool", "0.9.32");
    const check = await checkSkillUpdate(skill, {
      home: fakeHome, env: binEnv(), exec: toolExec("0.9.32", "Usage: sometool").exec, now: NOW,
    });

    expect(check.status).toBe("up-to-date");
    expect(check.summary).toContain("0.9.32");
  });

  it("is unknown, not behind, when the skill is newer than the command", async () => {
    const skill = markedSkill("sometool", "1.1.0");
    const check = await checkSkillUpdate(skill, {
      home: fakeHome, env: binEnv(), exec: toolExec("1.0.0", "Usage: sometool").exec, now: NOW,
    });

    expect(check.status).toBe("unknown");
    expect(check.detail).toContain("older half");
  });

  it("is unknown when the marker holds something that isn't a version", async () => {
    const dir = makeSkillDir(work, "sometool-skill");
    fs.writeFileSync(path.join(dir, ".sometool_version"), "installed from main\n");
    putOnPath("sometool");

    const check = (await checkSkillUpdate(skillAt(dir), {
      home: fakeHome, env: binEnv(), exec: toolExec("1.0.0", "Usage: sometool").exec, now: NOW,
    })) as ToolUpdateCheck;

    expect(check.method).toBe("tool");
    expect(check.status).toBe("unknown");
    expect(check.markerVersion).toBeNull();
  });

  it("falls back to manual when the marker names a command that isn't installed", async () => {
    const dir = makeSkillDir(work, "orphan");
    fs.writeFileSync(path.join(dir, ".sometool_version"), "1.0.0\n");

    const check = (await checkSkillUpdate(skillAt(dir), {
      home: fakeHome, env: emptyEnv, exec: forbiddenExec, now: NOW,
    })) as ManualUpdateCheck;

    expect(check.method).toBe("manual");
    expect(check.markerFile).toContain(".sometool_version");
    expect(check.detail).toContain("no matching command is installed");
  });
});

// --- manual ----------------------------------------------------------------

describe("a skill nothing on disk explains", () => {
  it("reports where it lives and when it changed instead of guessing", async () => {
    const dir = makeSkillDir(work, "hand-written");
    const changed = new Date("2026-07-11T09:00:00Z");
    fs.utimesSync(path.join(dir, "SKILL.md"), changed, changed);
    fs.utimesSync(dir, changed, changed);

    const check = (await checkSkillUpdate(skillAt(dir), {
      home: fakeHome, env: emptyEnv, exec: forbiddenExec, now: NOW,
    })) as ManualUpdateCheck;

    expect(check.method).toBe("manual");
    expect(check.status).toBe("unknown");
    expect(check.command).toBeNull();
    expect(check.dir).toBe(dir);
    expect(check.lastModified?.toISOString().slice(0, 10)).toBe("2026-07-11");
    expect(check.detail).toContain(dir);
    expect(check.detail).toContain("2026-07-11");
  });
});

// --- precedence and the whole list ----------------------------------------

describe("which kind of evidence wins", () => {
  it("prefers the bundle record over a git clone inside it", async () => {
    const installPath = path.join(fakeHome, ".claude", "plugins", "cache", "thing", "1.0.0");
    writePluginState({ pluginId: "thing@some-marketplace", installedVersion: "1.0.0", installPath, catalogVersion: "1.0.0" });
    const dir = makeSkillDir(path.join(installPath, "skills"), "bundled");
    fs.mkdirSync(path.join(dir, ".git"));

    const check = await checkSkillUpdate(skillAt(dir, { source: "plugin", pluginId: "thing@some-marketplace", switchable: false }), {
      home: fakeHome, env: emptyEnv, exec: forbiddenExec, now: NOW,
    });

    expect(check.method).toBe("plugin");
  });

  it("prefers a git clone over a version marker", async () => {
    const dir = makeSkillDir(work, "both");
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(path.join(dir, ".sometool_version"), "1.0.0\n");
    putOnPath("sometool");

    const check = await checkSkillUpdate(skillAt(dir), {
      home: fakeHome, env: binEnv(),
      exec: makeExec((file) => (file === "git" ? "" : null)).exec,
      now: NOW,
    });

    expect(check.method).toBe("git");
  });
});

describe("checking a whole list", () => {
  it("counts what the screen needs and keeps every skill", async () => {
    const skills = [
      skillAt(makeSkillDir(work, "one")),
      skillAt(makeSkillDir(work, "two")),
      skillAt(makeSkillDir(work, "three")),
    ];
    const checks = await listSkillUpdates(skills, {
      home: fakeHome, env: emptyEnv, exec: forbiddenExec, now: NOW,
    });

    expect(checks).toHaveLength(3);
    expect(summarizeUpdates(checks)).toEqual({ behind: 0, upToDate: 0, unknown: 3, actionable: 0 });
  });

  it("counts a behind-with-a-command skill as actionable", async () => {
    const installPath = path.join(fakeHome, ".claude", "plugins", "cache", "thing", "1.0.0");
    writePluginState({ pluginId: "thing@some-marketplace", installedVersion: "1.0.0", installPath, catalogVersion: "1.2.0" });
    putOnPath("claude");
    const dir = makeSkillDir(path.join(installPath, "skills"), "bundled");

    const checks = await listSkillUpdates(
      [skillAt(dir, { source: "plugin", pluginId: "thing@some-marketplace" }), skillAt(makeSkillDir(work, "plain"))],
      { home: fakeHome, env: binEnv(), exec: forbiddenExec, now: NOW },
    );

    expect(summarizeUpdates(checks)).toEqual({ behind: 1, upToDate: 0, unknown: 1, actionable: 1 });
  });

  it("works on what listSkills actually produces", async () => {
    // The engine takes skills.ts's own type rather than a parallel one, so a
    // real enumeration has to flow through it unchanged.
    const repoDir = path.join(work, "repo");
    makeSkillDir(path.join(repoDir, ".claude", "skills"), "local-helper");

    const skills = listSkills(resolvePaths(repoDir)).filter((s) => s.name === "local-helper");
    expect(skills).toHaveLength(1);

    const checks = await listSkillUpdates(skills, {
      home: fakeHome, env: emptyEnv, exec: forbiddenExec, now: NOW,
    });
    expect(checks[0]?.method).toBe("manual");
    expect(checks[0]?.skill.name).toBe("local-helper");
  });
});

describe("how child processes are run", () => {
  it("passes an argv array, never a shell line", async () => {
    const dir = makeSkillDir(work, "quoting; rm -rf $HOME");
    fs.mkdirSync(path.join(dir, ".git"));
    const stub = makeExec((file) => (file === "git" ? "" : null));

    await checkSkillUpdate(skillAt(dir), { home: fakeHome, env: emptyEnv, exec: stub.exec, now: NOW });

    expect(stub.calls.length).toBeGreaterThan(0);
    for (const call of stub.calls) {
      expect(Array.isArray(call.args)).toBe(true);
      // The directory travels as one argv element, so its contents are inert.
      expect(call.args).toContain(dir);
      expect(call.file).toBe("git");
    }
  });

  it("never spawns anything for a skill with no evidence to check", async () => {
    const dir = makeSkillDir(work, "quiet");
    await expect(
      checkSkillUpdate(skillAt(dir), { home: fakeHome, env: emptyEnv, exec: forbiddenExec, now: NOW }),
    ).resolves.toMatchObject({ method: "manual" });
  });
});
