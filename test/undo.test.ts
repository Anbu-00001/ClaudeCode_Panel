import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendUndoEntry, readUndoLog, readUndoLogNewestFirst, revertEntry, undoLogPath } from "../src/core/undo.js";
import { runTransaction, serializeJson } from "../src/core/write.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedirMock = vi.fn(actual.homedir);
  return { ...actual, homedir: homedirMock, default: { ...actual, homedir: homedirMock } };
});

let workDir: string;
let fakeHome: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-undo-"));
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-home-"));
  vi.mocked(os.homedir).mockReturnValue(fakeHome);
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

const meta = { kind: "kit", id: "code-reviewer", label: "Set up: Claude reviews your code before you commit" };

describe("undo log (§12.3)", () => {
  it("appends one entry per install and reads it back", () => {
    appendUndoEntry(meta, [
      { file: "/x/.claude/agents/reviewer.md", op: "create", backupPath: null, existedBefore: false },
    ]);
    const entries = readUndoLog();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe(meta.label);
    expect(entries[0]?.changes[0]?.op).toBe("create");
  });

  it("shows history newest first (§10.6)", () => {
    appendUndoEntry({ ...meta, id: "first", label: "First" }, []);
    appendUndoEntry({ ...meta, id: "second", label: "Second" }, []);
    expect(readUndoLogNewestFirst()[0]?.label).toBe("Second");
  });

  it("caps the log at 500 entries, keeping the most recent", () => {
    for (let i = 0; i < 505; i++) {
      appendUndoEntry({ kind: "kit", id: `k${i}`, label: `Label ${i}` }, []);
    }
    const entries = readUndoLog();
    expect(entries).toHaveLength(500);
    expect(entries.at(-1)?.label).toBe("Label 504");
    expect(entries[0]?.label).toBe("Label 5");
  });

  it("skips a torn final line rather than losing the whole history", () => {
    appendUndoEntry(meta, []);
    fs.appendFileSync(undoLogPath(), '{"uid":"broken","ts":');
    expect(readUndoLog()).toHaveLength(1);
  });

  it("reverting an entry restores the disk and is itself logged", () => {
    const target = path.join(workDir, "settings.json");
    fs.writeFileSync(target, serializeJson({ permissions: { allow: ["Bash(ls)"] } }));

    const tx = runTransaction(
      [
        {
          kind: "patchJson",
          filePath: target,
          keyPath: ["permissions", "allow"],
          mutate: (draft) => {
            (draft["permissions"] as { allow: string[] }).allow.push("Bash(git diff *)");
          },
        },
      ],
      meta,
      appendUndoEntry,
    );
    expect(tx.ok).toBe(true);

    const entry = readUndoLogNewestFirst()[0];
    const result = revertEntry(entry?.uid as string);

    expect(result.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({
      permissions: { allow: ["Bash(ls)"] },
    });
    expect(readUndoLogNewestFirst()[0]?.revertOf).toBe(entry?.uid);
  });

  it("reverting a created file deletes it", () => {
    const created = path.join(workDir, "agents", "reviewer.md");
    runTransaction([{ kind: "createFile", filePath: created, contents: "hi\n" }], meta, appendUndoEntry);
    expect(fs.existsSync(created)).toBe(true);

    revertEntry(readUndoLogNewestFirst()[0]?.uid as string);
    expect(fs.existsSync(created)).toBe(false);
  });

  it("reports a miss for an unknown entry instead of throwing", () => {
    expect(revertEntry("does-not-exist").ok).toBe(false);
  });
});

describe("acceptance #5: secrets never reach the undo log", () => {
  it("writes an MCP credential to disk but records only dots", () => {
    const target = path.join(workDir, ".mcp.json");

    const tx = runTransaction(
      [
        {
          kind: "patchJson",
          filePath: target,
          keyPath: ["mcpServers"],
          mutate: (draft) => {
            draft["mcpServers"] = {
              db: { command: "npx", env: { API_KEY: "sk-ant-abc123secret" } },
            };
          },
        },
      ],
      { kind: "kit", id: "database", label: "Set up: Claude reads your database" },
      appendUndoEntry,
    );
    expect(tx.ok).toBe(true);

    // The real value must still reach the config file — masking is for display.
    expect(fs.readFileSync(target, "utf8")).toContain("sk-ant-abc123secret");

    // ...but must not appear anywhere in the undo log.
    const logText = fs.readFileSync(undoLogPath(), "utf8");
    expect(logText).not.toContain("sk-ant");
    expect(logText).toContain("••••••••");

    const entry = readUndoLogNewestFirst()[0];
    expect(entry?.changes[0]?.secretRedacted).toBe(true);
  });

  it("keeps a secret out of the log even when only the key name is suggestive", () => {
    const target = path.join(workDir, "settings.json");
    runTransaction(
      [
        {
          kind: "patchJson",
          filePath: target,
          keyPath: ["env"],
          mutate: (draft) => {
            draft["env"] = { MY_PASSWORD: "hunter2" };
          },
        },
      ],
      meta,
      appendUndoEntry,
    );
    expect(fs.readFileSync(undoLogPath(), "utf8")).not.toContain("hunter2");
  });
});
