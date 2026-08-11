import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RepoInfo } from "../src/core/paths.js";
import { readFolderUsage, readSessionUsage, transcriptDirFor } from "../src/core/usage.js";

/**
 * CRITICAL: every transcript here is synthetic, written under a temp dir and
 * injected via `transcriptDir` — never the developer's real ~/.claude. This
 * repo has a documented past bug of tests writing into the real home dir.
 */

function fakeRepo(projectDir: string): RepoInfo {
  return {
    cwd: projectDir,
    isGitRepo: true,
    gitRoot: projectDir,
    projectDir,
    ancestorDirs: [projectDir],
  };
}

/** One line, shaped like a real transcript entry with a single tool_use block. */
function toolLine(opts: {
  sessionId: string;
  timestamp: string;
  name: string;
  extraBlocks?: unknown[];
}): string {
  const block = { type: "tool_use", id: "toolu_1", name: opts.name, input: {} };
  return JSON.stringify({
    sessionId: opts.sessionId,
    timestamp: opts.timestamp,
    cwd: "/somewhere",
    message: { role: "assistant", content: [block, ...(opts.extraBlocks ?? [])] },
  });
}

function writeLines(filePath: string, lines: string[]): void {
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

describe("usage", () => {
  let root: string;
  let transcriptDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-usage-"));
    transcriptDir = path.join(root, "projects", "-fake-folder");
    fs.mkdirSync(transcriptDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe("transcriptDirFor", () => {
    it("matches the verified real encoding rule (every non-alnum char -> '-')", () => {
      expect(transcriptDirFor("/home/anbu/25_class/Sem_4/EduAI", "/home/anbu")).toBe(
        path.join("/home/anbu", ".claude", "projects", "-home-anbu-25-class-Sem-4-EduAI"),
      );
    });

    it("defaults to the real home dir when none is given (pure string join, no I/O)", () => {
      expect(transcriptDirFor("/x/y")).toBe(path.join(os.homedir(), ".claude", "projects", "-x-y"));
    });
  });

  describe("no data vs. genuinely zero", () => {
    it("reports transcriptsFound === 0 and latestSessionId null when the folder has no transcripts at all", async () => {
      const emptyDir = path.join(root, "never-used");
      const repo = fakeRepo("/whatever");
      const report = await readFolderUsage(repo, { transcriptDir: emptyDir });

      expect(report.transcriptsFound).toBe(0);
      expect(report.sessions).toBe(0);
      expect(report.latestSessionId).toBeNull();
      expect(report.totalCalls).toBe(0);
      expect(report.byTool.size).toBe(0);
      expect(report.byServer.size).toBe(0);
    });

    it("reports a real zero (transcripts exist, nothing in them counts) distinctly from no data", async () => {
      // A transcript with only a text block — never a tool call — must still
      // register as data we HAVE, not data we're missing.
      const line = JSON.stringify({
        sessionId: "s1",
        timestamp: "2026-08-01T10:00:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      });
      writeLines(path.join(transcriptDir, "s1.jsonl"), [line]);

      const repo = fakeRepo("/whatever");
      const report = await readFolderUsage(repo, { transcriptDir });

      expect(report.transcriptsFound).toBe(1);
      expect(report.sessions).toBe(1);
      expect(report.latestSessionId).toBe("s1");
      expect(report.totalCalls).toBe(0);
      expect(report.byTool.size).toBe(0);
    });
  });

  describe("counting calls", () => {
    it("aggregates calls across multiple transcripts, split by tool and by MCP server", async () => {
      writeLines(path.join(transcriptDir, "s1.jsonl"), [
        toolLine({ sessionId: "s1", timestamp: "2026-08-01T10:00:00.000Z", name: "Bash" }),
        toolLine({ sessionId: "s1", timestamp: "2026-08-01T10:01:00.000Z", name: "Bash" }),
        toolLine({
          sessionId: "s1",
          timestamp: "2026-08-01T10:02:00.000Z",
          name: "mcp__serena__find_symbol",
        }),
      ]);
      writeLines(path.join(transcriptDir, "s2.jsonl"), [
        toolLine({ sessionId: "s2", timestamp: "2026-08-02T09:00:00.000Z", name: "Bash" }),
        toolLine({
          sessionId: "s2",
          timestamp: "2026-08-02T09:01:00.000Z",
          name: "mcp__serena__get_symbols_overview",
        }),
        toolLine({
          sessionId: "s2",
          timestamp: "2026-08-02T09:02:00.000Z",
          name: "mcp__codegraph__codegraph_explore",
        }),
      ]);

      const repo = fakeRepo("/whatever");
      const report = await readFolderUsage(repo, { transcriptDir });

      expect(report.totalCalls).toBe(6);
      expect(report.transcriptsFound).toBe(2);
      expect(report.sessions).toBe(2);

      expect(report.byTool.get("Bash")?.calls).toBe(3);
      expect(report.byTool.get("mcp__serena__find_symbol")?.calls).toBe(1);
      expect(report.byTool.get("mcp__serena__get_symbols_overview")?.calls).toBe(1);
      expect(report.byTool.get("mcp__codegraph__codegraph_explore")?.calls).toBe(1);

      expect(report.byServer.get("serena")?.calls).toBe(2);
      expect(report.byServer.get("codegraph")?.calls).toBe(1);
      expect(report.byServer.has("Bash")).toBe(false); // built-ins never appear as a "server"
    });

    it("tracks lastUsed as the max timestamp seen, regardless of line order", async () => {
      writeLines(path.join(transcriptDir, "s1.jsonl"), [
        toolLine({ sessionId: "s1", timestamp: "2026-08-01T10:05:00.000Z", name: "Bash" }),
        toolLine({ sessionId: "s1", timestamp: "2026-08-01T10:01:00.000Z", name: "Bash" }), // out of order
        toolLine({ sessionId: "s1", timestamp: "2026-08-01T10:09:00.000Z", name: "Bash" }),
      ]);

      const repo = fakeRepo("/whatever");
      const report = await readFolderUsage(repo, { transcriptDir });

      expect(report.byTool.get("Bash")?.lastUsed?.toISOString()).toBe("2026-08-01T10:09:00.000Z");
    });

    it("derives the server from only the first two `__` segments", async () => {
      writeLines(path.join(transcriptDir, "s1.jsonl"), [
        toolLine({ sessionId: "s1", timestamp: "2026-08-01T10:00:00.000Z", name: "mcp__foo__bar__baz" }),
      ]);

      const repo = fakeRepo("/whatever");
      const report = await readFolderUsage(repo, { transcriptDir });

      expect(report.byServer.has("foo")).toBe(true);
      expect(report.byServer.get("foo")?.calls).toBe(1);
      expect(report.byTool.has("mcp__foo__bar__baz")).toBe(true);
    });
  });

  describe("readSessionUsage", () => {
    it("scopes to only the most recently modified transcript", async () => {
      const older = path.join(transcriptDir, "old-session.jsonl");
      const newer = path.join(transcriptDir, "new-session.jsonl");
      writeLines(older, [toolLine({ sessionId: "old-session", timestamp: "2026-08-01T10:00:00.000Z", name: "Bash" })]);
      writeLines(newer, [
        toolLine({ sessionId: "new-session", timestamp: "2026-08-02T10:00:00.000Z", name: "Read" }),
      ]);

      // Explicit mtimes rather than relying on write-order timing, so the test
      // can't flake on a fast filesystem where both writes land in the same tick.
      const now = Date.now() / 1000;
      fs.utimesSync(older, now - 3600, now - 3600);
      fs.utimesSync(newer, now, now);

      const repo = fakeRepo("/whatever");
      const report = await readSessionUsage(repo, { transcriptDir });

      expect(report.latestSessionId).toBe("new-session");
      expect(report.transcriptsFound).toBe(2); // the folder has 2; this report is scoped to 1
      expect(report.sessions).toBe(1);
      expect(report.totalCalls).toBe(1);
      expect(report.byTool.has("Read")).toBe(true);
      expect(report.byTool.has("Bash")).toBe(false); // the older session's calls are excluded
    });

    it("returns the no-data shape when the folder has no transcripts", async () => {
      const repo = fakeRepo("/whatever");
      const report = await readSessionUsage(repo, { transcriptDir: path.join(root, "nope") });

      expect(report.latestSessionId).toBeNull();
      expect(report.transcriptsFound).toBe(0);
      expect(report.sessions).toBe(0);
      expect(report.totalCalls).toBe(0);
    });
  });

  describe("robustness — malformed input must never throw", () => {
    it("skips garbage lines, truncated JSON, and off-shape entries, while still counting the good ones", async () => {
      const lines = [
        "not json at all {{{",
        JSON.stringify({ sessionId: "s1", timestamp: "bad-date", message: { content: "a plain string, not an array" } }),
        JSON.stringify({ sessionId: "s1" }), // no message field
        JSON.stringify({ sessionId: "s1", message: {} }), // message present, no content
        JSON.stringify({ sessionId: "s1", message: { content: [null, 42, "text"] } }), // non-object blocks
        JSON.stringify({ sessionId: "s1", message: { content: [{ type: "tool_use" }] } }), // missing name
        JSON.stringify({
          sessionId: "s1",
          message: { content: [{ type: "text", text: "mentions tool_use in prose but isn't one" }] },
        }),
        toolLine({ sessionId: "s1", timestamp: "2026-08-01T10:00:00.000Z", name: "Bash" }),
        // a truncated tail, as if the writer was killed mid-line (no closing brace, no trailing newline)
        '{"sessionId":"s1","message":{"content":[{"type":"tool_use","name":"Edit"',
      ];
      const filePath = path.join(transcriptDir, "s1.jsonl");
      fs.writeFileSync(filePath, lines.join("\n"), "utf8"); // note: no trailing newline, mirrors a live-appended file

      const repo = fakeRepo("/whatever");
      const report = await readFolderUsage(repo, { transcriptDir }); // must not throw or reject
      expect(report.totalCalls).toBe(1);
      expect(report.byTool.get("Bash")?.calls).toBe(1);
      expect(report.byTool.has("Edit")).toBe(false); // truncated line never parsed
    });

    it("ignores a directory that happens to be named *.jsonl", async () => {
      fs.mkdirSync(path.join(transcriptDir, "not-a-file.jsonl"));

      const repo = fakeRepo("/whatever");
      const report = await readFolderUsage(repo, { transcriptDir });

      expect(report.transcriptsFound).toBe(0);
      expect(report.sessions).toBe(0);
    });

    it("excludes an unreadable file from sessions without throwing", async () => {
      if (process.getuid && process.getuid() === 0) {
        return; // root ignores file permissions — nothing to assert here
      }
      const filePath = path.join(transcriptDir, "locked.jsonl");
      writeLines(filePath, [toolLine({ sessionId: "locked", timestamp: "2026-08-01T10:00:00.000Z", name: "Bash" })]);
      fs.chmodSync(filePath, 0o000);

      try {
        const repo = fakeRepo("/whatever");
        const report = await readFolderUsage(repo, { transcriptDir });

        // Still visible in the directory listing (we know it exists)...
        expect(report.transcriptsFound).toBe(1);
        // ...but never successfully read, so it can't contribute a false zero either.
        expect(report.sessions).toBe(0);
        expect(report.totalCalls).toBe(0);
      } finally {
        fs.chmodSync(filePath, 0o644); // so afterEach's rmSync can clean up
      }
    });
  });

  describe("end-to-end folder resolution (no transcriptDir override)", () => {
    it("finds transcripts through the real home + encoding path when only `home` is injected", async () => {
      const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-usage-home-"));
      try {
        const projectDir = "/some/project/dir";
        const dir = transcriptDirFor(projectDir, fakeHome);
        fs.mkdirSync(dir, { recursive: true });
        writeLines(path.join(dir, "abc.jsonl"), [
          toolLine({ sessionId: "abc", timestamp: "2026-08-01T10:00:00.000Z", name: "WebSearch" }),
        ]);

        const repo = fakeRepo(projectDir);
        const report = await readFolderUsage(repo, { home: fakeHome });

        expect(report.transcriptsFound).toBe(1);
        expect(report.byTool.get("WebSearch")?.calls).toBe(1);
      } finally {
        fs.rmSync(fakeHome, { recursive: true, force: true });
      }
    });
  });

  describe("performance", () => {
    it("counts a large synthetic transcript well within budget", async () => {
      const LINES = 60_000;
      const parts: string[] = [];
      for (let i = 0; i < LINES; i++) {
        if (i % 5 === 0) {
          parts.push(toolLine({ sessionId: "big", timestamp: "2026-08-01T10:00:00.000Z", name: "Bash" }));
        } else {
          // Realistic filler: a plain text turn, roughly the size of real prose.
          parts.push(
            JSON.stringify({
              sessionId: "big",
              timestamp: "2026-08-01T10:00:00.000Z",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Some ordinary reply with no tool call in it, ".repeat(4) }],
              },
            }),
          );
        }
      }
      const filePath = path.join(transcriptDir, "big.jsonl");
      fs.writeFileSync(filePath, `${parts.join("\n")}\n`, "utf8");

      const repo = fakeRepo("/whatever");
      const start = performance.now();
      const report = await readFolderUsage(repo, { transcriptDir });
      const elapsedMs = performance.now() - start;

      expect(report.totalCalls).toBe(LINES / 5);
      expect(elapsedMs).toBeLessThan(3000); // generous vs. the app's own 1.5s cold-start budget
    });
  });
});
