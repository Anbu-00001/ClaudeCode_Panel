import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateByFilename, validateClaudeJson, validateSettings } from "../src/core/validate.js";
import {
  atomicWriteFile,
  BACKUP_KEEP_PER_FILE,
  BACKUP_MAX_AGE_MS,
  backupKey,
  backupsDir,
  describeInvalid,
  findFencedBlock,
  type Operation,
  runTransaction,
  serializeJson,
  snapshot,
} from "../src/core/write.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedirMock = vi.fn(actual.homedir);
  return { ...actual, homedir: homedirMock, default: { ...actual, homedir: homedirMock } };
});

let workDir: string;
let fakeHome: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-write-"));
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-home-"));
  vi.mocked(os.homedir).mockReturnValue(fakeHome);
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

const meta = { kind: "kit", id: "test-kit", label: "Set up: test kit" };

describe("atomicWriteFile", () => {
  it("writes 2-space indented JSON with a trailing newline, matching Claude Code's style", () => {
    const target = path.join(workDir, "settings.json");
    atomicWriteFile(target, serializeJson({ a: 1, b: { c: 2 } }));
    expect(fs.readFileSync(target, "utf8")).toBe('{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}\n');
  });

  it("preserves an existing file's mode — a 0600 config must not become world-readable", () => {
    const target = path.join(workDir, "settings.json");
    fs.writeFileSync(target, "{}\n");
    fs.chmodSync(target, 0o600);

    atomicWriteFile(target, serializeJson({ changed: true }));

    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it("creates new config files as 0600 regardless of umask", () => {
    const target = path.join(workDir, "new-settings.json");
    atomicWriteFile(target, serializeJson({ a: 1 }));
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it("writes through a symlinked settings.local.json, keeping the link", () => {
    const dotfiles = path.join(workDir, "dotfiles");
    fs.mkdirSync(dotfiles);
    const real = path.join(dotfiles, "claude-local.json");
    fs.writeFileSync(real, serializeJson({ keep: 1 }));
    const link = path.join(workDir, ".claude", "settings.local.json");
    fs.mkdirSync(path.dirname(link));
    fs.symlinkSync(real, link);

    const result = runTransaction(
      [
        {
          kind: "patchJson",
          filePath: link,
          keyPath: ["permissions"],
          mutate: (d) => {
            d["permissions"] = { allow: ["Bash(ls *)"] };
          },
        },
      ],
      meta,
    );

    expect(result.ok).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, "utf8"))).toEqual({
      keep: 1,
      permissions: { allow: ["Bash(ls *)"] },
    });
    // The temp file went next to the real file, and didn't stay behind.
    expect(fs.readdirSync(dotfiles)).toEqual(["claude-local.json"]);
  });

  it("creates the file a dangling symlink points to", () => {
    const real = path.join(workDir, "elsewhere", "new.json");
    fs.mkdirSync(path.dirname(real));
    const link = path.join(workDir, "link.json");
    fs.symlinkSync(real, link);

    atomicWriteFile(link, serializeJson({ a: 1 }));

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, "utf8"))).toEqual({ a: 1 });
  });

  it("leaves no temp files behind", () => {
    const target = path.join(workDir, "settings.json");
    atomicWriteFile(target, serializeJson({ a: 1 }));
    const leftovers = fs
      .readdirSync(workDir)
      .filter((f) => f.includes("ccpanel") && f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("write protocol (§12.1)", () => {
  it("acceptance #1: refuses to write a settings.json with a trailing comma, leaving it byte-identical", () => {
    const target = path.join(workDir, "settings.json");
    const broken = '{\n  "permissions": { "allow": ["Bash(ls)"] },\n}\n';
    fs.writeFileSync(target, broken);
    const before = fs.readFileSync(target);

    const result = runTransaction(
      [
        {
          kind: "patchJson",
          filePath: target,
          keyPath: ["permissions", "allow"],
          mutate: (draft) => {
            draft["permissions"] = { allow: ["Bash(git diff *)"] };
          },
        },
      ],
      meta,
    );

    expect(result.ok).toBe(false);
    expect(result.failure?.reason).toBe("unparseable");
    expect(fs.readFileSync(target)).toEqual(before);
  });

  it("reports the line number of a parse failure so Repair can point at it", () => {
    const target = path.join(workDir, "settings.json");
    fs.writeFileSync(target, '{\n  "a": 1,\n  "b": 2,\n}\n');

    const result = runTransaction(
      [
        {
          kind: "patchJson",
          filePath: target,
          keyPath: ["a"],
          mutate: (d) => {
            d["a"] = 2;
          },
        },
      ],
      meta,
    );

    expect(result.ok).toBe(false);
    if (result.failure?.reason === "unparseable") {
      expect(result.failure.failure.line).toBe(4);
    } else {
      throw new Error("expected an unparseable failure");
    }
  });

  it("acceptance #2: leaves every unrelated key untouched, including ones it doesn't model", () => {
    const target = path.join(workDir, "settings.json");
    const original = {
      permissions: { allow: ["Bash(ls)"], deny: ["Bash(rm *)"] },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "x.sh" }] }] },
      someKeyCcpanelHasNeverHeardOf: { nested: { deep: [1, 2, 3] } },
      anotherUnknown: "keep me",
    };
    fs.writeFileSync(target, serializeJson(original));

    const result = runTransaction(
      [
        {
          kind: "patchJson",
          filePath: target,
          keyPath: ["permissions", "allow"],
          mutate: (draft) => {
            const perms = draft["permissions"] as { allow: string[] };
            perms.allow = [...perms.allow, "Bash(git diff *)"];
          },
        },
      ],
      meta,
    );

    expect(result.ok).toBe(true);
    const after = JSON.parse(fs.readFileSync(target, "utf8"));
    expect(after.someKeyCcpanelHasNeverHeardOf).toEqual(original.someKeyCcpanelHasNeverHeardOf);
    expect(after.anotherUnknown).toBe("keep me");
    expect(after.hooks).toEqual(original.hooks);
    expect(after.permissions.deny).toEqual(["Bash(rm *)"]);
    expect(after.permissions.allow).toEqual(["Bash(ls)", "Bash(git diff *)"]);
  });

  it("treats a missing file as {} and creates it", () => {
    const target = path.join(workDir, ".claude", "settings.local.json");
    const result = runTransaction(
      [
        {
          kind: "patchJson",
          filePath: target,
          keyPath: ["permissions"],
          mutate: (draft) => {
            draft["permissions"] = { allow: ["Bash(git status *)"] };
          },
        },
      ],
      meta,
    );

    expect(result.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({
      permissions: { allow: ["Bash(git status *)"] },
    });
    expect(result.changes[0]?.existedBefore).toBe(false);
  });

  it("rejects a value that violates the schema without writing anything", () => {
    const target = path.join(workDir, "settings.json");
    fs.writeFileSync(target, serializeJson({ existing: true }));
    const before = fs.readFileSync(target);

    const result = runTransaction(
      [
        {
          kind: "patchJson",
          filePath: target,
          keyPath: ["skillOverrides"],
          mutate: (draft) => {
            // "sometimes" is not one of the four documented states
            draft["skillOverrides"] = { deploy: "sometimes" };
          },
        },
      ],
      meta,
    );

    expect(result.ok).toBe(false);
    expect(result.failure?.reason).toBe("invalid");
    expect(fs.readFileSync(target)).toEqual(before);
  });

  it("doesn't let a problem in a key it isn't changing block the write", () => {
    const target = path.join(workDir, "settings.json");
    // Claude Code wants strings in env; the user wrote a number.
    fs.writeFileSync(target, serializeJson({ env: { PORT: 3000 } }));

    const result = runTransaction(
      [
        {
          kind: "patchJson",
          filePath: target,
          keyPath: ["permissions"],
          mutate: (d) => {
            d["permissions"] = { allow: ["Bash(ls *)"] };
          },
        },
      ],
      meta,
    );

    expect(result.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({
      env: { PORT: 3000 },
      permissions: { allow: ["Bash(ls *)"] },
    });
  });

  it("names the file and the entry when it refuses a write", () => {
    const target = path.join(workDir, "settings.json");
    const result = runTransaction(
      [
        {
          kind: "patchJson",
          filePath: target,
          keyPath: ["skillOverrides"],
          mutate: (d) => {
            d["skillOverrides"] = { deploy: "sometimes" };
          },
        },
      ],
      meta,
    );
    expect(result.failure?.reason).toBe("invalid");
    const text = describeInvalid(result.failure as Parameters<typeof describeInvalid>[0]);
    expect(text).toContain("settings.json");
    expect(text).toContain('"skillOverrides.deploy"');
  });

  it("accepts all four documented skillOverrides states", () => {
    const target = path.join(workDir, "settings.local.json");
    const result = runTransaction(
      [
        {
          kind: "patchJson",
          filePath: target,
          keyPath: ["skillOverrides"],
          mutate: (draft) => {
            draft["skillOverrides"] = {
              a: "on",
              b: "name-only",
              c: "user-invocable-only",
              d: "off",
            };
          },
        },
      ],
      meta,
    );
    expect(result.ok).toBe(true);
  });
});

describe("transactions", () => {
  it("acceptance #4: rolls back earlier steps when a later one fails", () => {
    const fileA = path.join(workDir, "a.md");
    const fileB = path.join(workDir, "b.md");
    const settings = path.join(workDir, "settings.json");
    const blocker = path.join(workDir, "blocked.md");

    fs.writeFileSync(settings, serializeJson({ permissions: { allow: ["Bash(ls)"] } }));
    fs.writeFileSync(blocker, "a user's own file that must not be clobbered\n");
    const settingsBefore = fs.readFileSync(settings);

    const ops: Operation[] = [
      { kind: "createFile", filePath: fileA, contents: "A\n" },
      { kind: "createFile", filePath: fileB, contents: "B\n" },
      {
        kind: "patchJson",
        filePath: settings,
        keyPath: ["permissions", "allow"],
        mutate: (draft) => {
          (draft["permissions"] as { allow: string[] }).allow.push("Bash(git diff *)");
        },
      },
      // Step 4 fails: something different is already at this path.
      { kind: "createFile", filePath: blocker, contents: "ours\n" },
    ];

    const result = runTransaction(ops, meta);

    expect(result.ok).toBe(false);
    expect(result.failure?.reason).toBe("conflict");
    expect(fs.existsSync(fileA)).toBe(false);
    expect(fs.existsSync(fileB)).toBe(false);
    expect(fs.readFileSync(settings)).toEqual(settingsBefore);
    expect(fs.readFileSync(blocker, "utf8")).toBe("a user's own file that must not be clobbered\n");
  });

  it("records one change per applied operation on success", () => {
    const result = runTransaction(
      [
        { kind: "createFile", filePath: path.join(workDir, "x.md"), contents: "x\n" },
        { kind: "createFile", filePath: path.join(workDir, "y.md"), contents: "y\n" },
      ],
      meta,
    );
    expect(result.ok).toBe(true);
    expect(result.changes).toHaveLength(2);
  });

  it("passes the completed changes to the undo recorder exactly once", () => {
    const recorder = vi.fn();
    runTransaction(
      [{ kind: "createFile", filePath: path.join(workDir, "z.md"), contents: "z\n" }],
      meta,
      recorder,
    );
    expect(recorder).toHaveBeenCalledTimes(1);
  });

  it("does not record an undo entry when the transaction fails", () => {
    const recorder = vi.fn();
    fs.writeFileSync(path.join(workDir, "taken.md"), "theirs\n");
    runTransaction(
      [{ kind: "createFile", filePath: path.join(workDir, "taken.md"), contents: "ours\n" }],
      meta,
      recorder,
    );
    expect(recorder).not.toHaveBeenCalled();
  });
});

describe("fenced CLAUDE.md blocks (§9.2)", () => {
  it("acceptance #6: uninstall removes only its own block, keeping the user's text above and below", () => {
    const claudeMd = path.join(workDir, "CLAUDE.md");
    fs.writeFileSync(claudeMd, "# My project\n\nMy own notes above.\n");

    const added = runTransaction(
      [
        {
          kind: "appendBlock",
          filePath: claudeMd,
          blockId: "code-reviewer",
          content: "Review rules here.",
        },
      ],
      meta,
    );
    expect(added.ok).toBe(true);

    fs.appendFileSync(claudeMd, "\nMy own notes below.\n");
    expect(findFencedBlock(fs.readFileSync(claudeMd, "utf8"), "code-reviewer")).not.toBeNull();

    const removed = runTransaction(
      [{ kind: "removeBlock", filePath: claudeMd, blockId: "code-reviewer" }],
      meta,
    );
    expect(removed.ok).toBe(true);

    const text = fs.readFileSync(claudeMd, "utf8");
    expect(text).toContain("My own notes above.");
    expect(text).toContain("My own notes below.");
    expect(text).not.toContain("Review rules here.");
    expect(text).not.toContain("ccpanel:code-reviewer");
  });

  it("never overwrites an existing CLAUDE.md, only appends", () => {
    const claudeMd = path.join(workDir, "CLAUDE.md");
    fs.writeFileSync(claudeMd, "# Existing\n");
    runTransaction(
      [{ kind: "appendBlock", filePath: claudeMd, blockId: "kit", content: "added" }],
      meta,
    );
    expect(fs.readFileSync(claudeMd, "utf8")).toContain("# Existing");
  });

  it("treats a block that is already there as done, never appending it twice", () => {
    const claudeMd = path.join(workDir, "CLAUDE.md");
    runTransaction(
      [{ kind: "appendBlock", filePath: claudeMd, blockId: "kit", content: "one" }],
      meta,
    );
    const before = fs.readFileSync(claudeMd, "utf8");
    const second = runTransaction(
      [{ kind: "appendBlock", filePath: claudeMd, blockId: "kit", content: "two" }],
      meta,
    );
    expect(second.ok).toBe(true);
    // Left exactly as it was: the user may have edited the text inside.
    expect(fs.readFileSync(claudeMd, "utf8")).toBe(before);
  });
});

describe("snapshots", () => {
  it("stores backups 0600 so a snapshot of a secrets file isn't world-readable", () => {
    const target = path.join(workDir, "settings.json");
    fs.writeFileSync(target, serializeJson({ apiKey: "sk-ant-abc123" }));
    const backup = snapshot(target);
    expect(backup).not.toBeNull();
    expect(fs.statSync(backup as string).mode & 0o777).toBe(0o600);
  });

  it("returns null when there is nothing to snapshot", () => {
    expect(snapshot(path.join(workDir, "nope.json"))).toBeNull();
  });

  it("names each backup after the file's full path, not just its name", () => {
    const a = path.join(workDir, "a", "settings.json");
    const b = path.join(workDir, "b", "settings.json");
    for (const f of [a, b]) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, "{}\n");
    }
    expect(backupKey(a)).not.toBe(backupKey(b));
    expect(path.basename(snapshot(a) as string)).toContain(backupKey(a));
  });

  it("keeps only the newest copies of one file", () => {
    const target = path.join(workDir, "settings.json");
    fs.writeFileSync(target, "{}\n");
    for (let i = 0; i < BACKUP_KEEP_PER_FILE + 5; i++) snapshot(target);

    const mine = fs.readdirSync(backupsDir()).filter((n) => n.endsWith(backupKey(target)));
    expect(mine).toHaveLength(BACKUP_KEEP_PER_FILE);
  });

  it("drops backups older than the age limit, whatever file they came from", () => {
    fs.mkdirSync(backupsDir(), { recursive: true });
    const ancient = path.join(backupsDir(), "2020-01-01T00:00:00.000Z-other.json");
    fs.writeFileSync(ancient, "{}");
    const old = new Date(Date.now() - BACKUP_MAX_AGE_MS - 60_000);
    fs.utimesSync(ancient, old, old);

    const target = path.join(workDir, "settings.json");
    fs.writeFileSync(target, "{}\n");
    const fresh = snapshot(target) as string;

    expect(fs.existsSync(ancient)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});

/**
 * The schemas exist to protect a user's file, so the thing worth testing is
 * that they accept what Claude Code actually writes. A schema that is wrong in
 * the strict direction is not a safe failure: validateByFilename runs before
 * every write, so it turns a legitimate settings file into one ccpanel refuses
 * to touch at all.
 */
describe("schemas match what Claude Code really writes", () => {
  it("accepts enabledPlugins as a map of plugin to on/off", () => {
    // The shape Claude Code writes, taken from a real ~/.claude/settings.json.
    const real = {
      enabledPlugins: {
        "pyright-lsp@claude-plugins-official": true,
        "typescript-lsp@claude-plugins-official": false,
      },
    };
    expect(validateSettings(real)).toEqual({ ok: true, issues: [] });
  });

  it("accepts a project entry carrying disabledMcpServers in ~/.claude.json", () => {
    const real = {
      mcpServers: { serena: { command: "serena" } },
      projects: {
        "/home/someone/thing": { disabledMcpServers: ["serena"], mcpContextUris: [] },
      },
    };
    expect(validateClaudeJson(real)).toEqual({ ok: true, issues: [] });
    expect(validateByFilename("/home/someone/.claude.json", real).ok).toBe(true);
  });

  it("keeps keys it has never heard of", () => {
    // Loose at every level: a future Claude Code key must survive a write.
    const withUnknowns = {
      enabledPlugins: { "a@b": true },
      somethingNew: { nested: { deeper: 1 } },
      projects: { "/x": { brandNewKey: "keep me" } },
    };
    expect(validateSettings(withUnknowns).ok).toBe(true);
    expect(validateClaudeJson(withUnknowns).ok).toBe(true);
  });
});
