import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getKit,
  installKit,
  isKitInstalled,
  KIT_ORDER,
  loadKits,
  previewUninstall,
  uninstallKit,
} from "../src/core/kits.js";
import { resolvePaths } from "../src/core/paths.js";
import { appendUndoEntry } from "../src/core/undo.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedirMock = vi.fn(actual.homedir);
  return { ...actual, homedir: homedirMock, default: { ...actual, homedir: homedirMock } };
});

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KITS = path.join(projectRoot, "kits");
const SCOPE_HOOK = path.join(KITS, "scope-guard", "hooks", "guard-important-files.sh");
const COMPACT_HOOK = path.join(KITS, "context-rescue", "hooks", "save-before-forgetting.sh");

let repoDir: string;
let fakeHome: string;

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-m5-"));
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-m5h-"));
  vi.mocked(os.homedir).mockReturnValue(fakeHome);
  execSync("git init -q . && git config user.email t@t && git config user.name t", {
    cwd: repoDir,
  });
});
afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

const repo = () => resolvePaths(repoDir);
const kit = (id: string) => getKit(id, KITS)!;

function runHook(script: string, payload: unknown, cwd = repoDir): string {
  try {
    return execFileSync("bash", [script], {
      input: JSON.stringify(payload),
      cwd,
      encoding: "utf8",
      timeout: 10_000,
    });
  } catch (e) {
    return (e as { stdout?: string }).stdout ?? "";
  }
}
const asks = (out: string) => out.includes('"permissionDecision":"ask"');

describe("the whole kit library", () => {
  it("loads every bundled kit in hand-curated order", () => {
    const kits = loadKits(KITS);
    // Tied to the curated order rather than a literal count, so adding a kit
    // doesn't fail a test that isn't about counting.
    expect(kits).toHaveLength(KIT_ORDER.length);
    expect(kits[0]?.id).toBe("deletion-warning");
    expect(kits[1]?.id).toBe("safe-permissions");
  });

  it("every kit states a newcomer problem, an honest limit, and something to try", () => {
    for (const k of loadKits(KITS)) {
      expect(k.newcomerProblem, `${k.id}`).toBeTruthy();
      expect(k.honestLimit, `${k.id}`).toBeTruthy();
      expect(k.tryThis, `${k.id}`).toBeTruthy();
    }
  });

  it("no kit uses a word a beginner would have to look up", () => {
    const banned = [
      "MCP",
      "subagent",
      "frontmatter",
      "stdio",
      "PreToolUse",
      "PreCompact",
      "settings.json",
    ];
    for (const k of loadKits(KITS)) {
      const text = `${k.title} ${k.blurb} ${k.explain} ${k.newcomerProblem} ${k.honestLimit}`;
      for (const w of banned) expect(text.includes(w), `${k.id} says "${w}"`).toBe(false);
    }
  });
});

describe("safe-permissions", () => {
  it("allows only look-only commands, never anything that changes things", () => {
    installKit(kit("safe-permissions"), repo(), appendUndoEntry);
    const allow: string[] = JSON.parse(
      fs.readFileSync(path.join(repoDir, ".claude", "settings.local.json"), "utf8"),
    ).permissions.allow;

    expect(allow).toContain("Bash(git status *)");
    for (const dangerous of [
      "rm",
      "git push",
      "git commit",
      "npm install",
      "curl",
      "mv ",
      "git reset",
      // Can delete branches: `git branch -D main`.
      "git branch",
      // Print any file, including ~/.ssh keys and .env files, without asking.
      "cat ",
      "head ",
      "tail ",
    ]) {
      expect(
        allow.some((r) => r.includes(dangerous)),
        `allows ${dangerous}`,
      ).toBe(false);
    }
  });
});

/**
 * Claude Code's rule matching for Bash: `*` stands for any run of characters,
 * spaces included. Good enough to check which rule a command falls under.
 */
function ruleMatches(rule: string, command: string): boolean {
  const inner = /^Bash\((.*)\)$/.exec(rule)?.[1];
  if (inner === undefined) return false;
  const pattern = inner.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${pattern.join(".*")}$`).test(command);
}

describe("git look-only permissions can't write files or read outside the project", () => {
  for (const id of ["safe-permissions", "code-reviewer", "commit-messages"]) {
    it(`${id}: asks before git output goes to a file or reads files elsewhere`, () => {
      installKit(kit(id), repo(), appendUndoEntry);
      const file = path.join(repoDir, ".claude", "settings.local.json");
      const perms = JSON.parse(fs.readFileSync(file, "utf8")).permissions as {
        allow: string[];
        ask: string[];
      };
      const asked = (cmd: string) => perms.ask.some((r) => ruleMatches(r, cmd));
      const allowed = (cmd: string) => perms.allow.some((r) => ruleMatches(r, cmd));

      for (const cmd of [
        "git diff --output=/home/me/.bashrc",
        "git diff HEAD --output /tmp/x",
        "git diff --no-index /dev/null /home/me/.ssh/id_rsa",
        "git diff /dev/null /home/me/.ssh/id_rsa",
        "git diff ~/.ssh/id_rsa /dev/null",
        "git diff --stat ../other-project/.env x",
        'git diff "$HOME/.ssh/id_rsa" a',
        "git log -p --output=notes.txt",
      ]) {
        expect(asked(cmd), cmd).toBe(true);
      }
      // Everyday use still goes straight through.
      for (const cmd of [
        "git diff --stat",
        "git diff HEAD~1 -- src/app.ts",
        "git diff main..feature",
        "git log --oneline -5",
      ]) {
        expect(allowed(cmd) && !asked(cmd), cmd).toBe(true);
      }

      uninstallKit(kit(id), repo(), appendUndoEntry);
      const after = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
      expect(after.permissions?.ask ?? []).toEqual([]);
    });
  }
});

describe("commit-messages", () => {
  it("installs an ability the model can't trigger on its own, since committing is a side effect", () => {
    installKit(kit("commit-messages"), repo(), appendUndoEntry);
    const skill = fs.readFileSync(
      path.join(repoDir, ".claude", "skills", "commit", "SKILL.md"),
      "utf8",
    );
    expect(skill).toMatch(/^disable-model-invocation: true$/m);
    expect(skill).toContain("Do not commit.");
  });
});

describe("scope-guard", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(repoDir, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, ".github", "workflows"), { recursive: true });
    for (const [f, c] of [
      [".claude/settings.json", "{}"],
      ["CLAUDE.md", "# hi"],
      ["package-lock.json", "{}"],
      ["src/app.ts", "x"],
      [".github/workflows/ci.yml", "on: push"],
    ] as const)
      fs.writeFileSync(path.join(repoDir, f), c);
  });

  for (const f of [
    ".claude/settings.json",
    "CLAUDE.md",
    "package-lock.json",
    ".github/workflows/ci.yml",
  ]) {
    it(`asks before changing ${f}`, () => {
      const out = runHook(SCOPE_HOOK, {
        tool_name: "Edit",
        tool_input: { file_path: path.join(repoDir, f) },
      });
      expect(asks(out)).toBe(true);
    });
  }

  it("stays silent for an ordinary source file", () => {
    expect(
      asks(
        runHook(SCOPE_HOOK, {
          tool_name: "Edit",
          tool_input: { file_path: path.join(repoDir, "src/app.ts") },
        }),
      ),
    ).toBe(false);
  });

  it("stays silent when creating a brand-new file, since nothing is destroyed", () => {
    expect(
      asks(
        runHook(SCOPE_HOOK, {
          tool_name: "Write",
          tool_input: { file_path: path.join(repoDir, "CLAUDE-new.md") },
        }),
      ),
    ).toBe(false);
  });

  it("ignores tools that don't change files", () => {
    expect(
      asks(
        runHook(SCOPE_HOOK, {
          tool_name: "Read",
          tool_input: { file_path: path.join(repoDir, "CLAUDE.md") },
        }),
      ),
    ).toBe(false);
  });

  it("fails open on rubbish input", () => {
    for (const bad of ["", "not json{{", "null", "[]"]) {
      let out = "";
      try {
        out = execFileSync("bash", [SCOPE_HOOK], {
          input: bad,
          cwd: repoDir,
          encoding: "utf8",
          timeout: 5000,
        });
      } catch {
        out = "";
      }
      expect(asks(out)).toBe(false);
    }
  });

  it("adds its scope rule to CLAUDE.md and removes exactly that on uninstall", () => {
    fs.writeFileSync(path.join(repoDir, "CLAUDE.md"), "# My project\n\nMy own notes.\n");
    installKit(kit("scope-guard"), repo(), appendUndoEntry);
    let text = fs.readFileSync(path.join(repoDir, "CLAUDE.md"), "utf8");
    expect(text).toContain("Staying in scope");

    uninstallKit(kit("scope-guard"), repo(), appendUndoEntry);
    text = fs.readFileSync(path.join(repoDir, "CLAUDE.md"), "utf8");
    expect(text).toContain("My own notes.");
    expect(text).not.toContain("Staying in scope");
  });
});

describe("context-rescue", () => {
  it("registers for both automatic and manual shortening", () => {
    installKit(kit("context-rescue"), repo(), appendUndoEntry);
    const hooks = JSON.parse(
      fs.readFileSync(path.join(repoDir, ".claude", "settings.json"), "utf8"),
    ).hooks;
    expect(hooks.PreCompact.map((h: { matcher: string }) => h.matcher).sort()).toEqual([
      "auto",
      "manual",
    ]);
  });

  it("writes a note naming the unsaved files, and never blocks", () => {
    fs.writeFileSync(path.join(repoDir, "work.ts"), "half-finished\n");
    execSync("git add -A && git commit -qm base", { cwd: repoDir });
    fs.appendFileSync(path.join(repoDir, "work.ts"), "more\n");

    runHook(COMPACT_HOOK, { hook_event_name: "PreCompact", trigger: "auto", cwd: repoDir });

    const note = fs.readFileSync(path.join(repoDir, ".claude", "where-we-got-to.md"), "utf8");
    expect(note).toContain("Where we got to");
    expect(note).toContain("work.ts");
    expect(note).not.toContain("where-we-got-to.md"); // must not list itself
  });

  it("keeps its note out of git, and deletes the note when removed", () => {
    installKit(kit("context-rescue"), repo(), appendUndoEntry);
    runHook(COMPACT_HOOK, { hook_event_name: "PreCompact", trigger: "auto", cwd: repoDir });
    const note = path.join(repoDir, ".claude", "where-we-got-to.md");
    expect(fs.existsSync(note)).toBe(true);
    const status = execSync("git status --porcelain --untracked-files=all", {
      cwd: repoDir,
      encoding: "utf8",
    });
    expect(status).not.toContain("where-we-got-to.md");

    expect(
      previewUninstall(kit("context-rescue"), repo()).some(
        (l) =>
          l.action === "delete" && l.displayPath === path.join(".claude", "where-we-got-to.md"),
      ),
    ).toBe(true);
    expect(uninstallKit(kit("context-rescue"), repo(), appendUndoEntry).ok).toBe(true);
    expect(fs.existsSync(note)).toBe(false);
  });

  it("still writes something useful outside a git repo", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-plain-"));
    runHook(COMPACT_HOOK, { hook_event_name: "PreCompact", trigger: "manual", cwd: plain }, plain);
    expect(fs.readFileSync(path.join(plain, ".claude", "where-we-got-to.md"), "utf8")).toContain(
      "not tracked by git",
    );
    fs.rmSync(plain, { recursive: true, force: true });
  });
});

describe("explore-first", () => {
  it("runs in its own space so searching doesn't fill the main conversation", () => {
    installKit(kit("explore-first"), repo(), appendUndoEntry);
    const skill = fs.readFileSync(
      path.join(repoDir, ".claude", "skills", "explore", "SKILL.md"),
      "utf8",
    );
    expect(skill).toMatch(/^context: fork$/m);
    expect(skill).toMatch(/^agent: Explore$/m);
  });
});

describe("every kit installs and uninstalls cleanly", () => {
  for (const id of loadKits(KITS).map((k) => k.id)) {
    it(`${id}: installs, is detected, and reverts`, () => {
      const k = kit(id);
      expect(installKit(k, repo(), appendUndoEntry).ok, `${id} install`).toBe(true);
      expect(isKitInstalled(k, repo()), `${id} detect`).toBe(true);
      expect(uninstallKit(k, repo(), appendUndoEntry).ok, `${id} uninstall`).toBe(true);
      expect(isKitInstalled(k, repo()), `${id} still there`).toBe(false);
    });
  }
});
