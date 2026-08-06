import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectLadderState } from "../src/core/detect.js";

// See test/paths.test.ts for why this needs vi.mock rather than vi.spyOn.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedirMock = vi.fn(actual.homedir);
  return { ...actual, homedir: homedirMock, default: { ...actual, homedir: homedirMock } };
});

describe("detectLadderState", () => {
  let projectDir: string;
  let fakeHome: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-proj-"));
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-home-"));
    vi.mocked(os.homedir).mockReturnValue(fakeHome);
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it("reports everything off in a bare directory — never guesses", () => {
    const state = detectLadderState(projectDir);
    for (const on of Object.values(state.rungs)) expect(on).toBe(false);
    expect(state.countOn).toBe(0);
  });

  it("detects instructions from a project CLAUDE.md", () => {
    fs.writeFileSync(path.join(projectDir, "CLAUDE.md"), "# hi");
    expect(detectLadderState(projectDir).rungs.instructions).toBe(true);
  });

  it("detects permissions from settings.local.json allow rules", () => {
    fs.mkdirSync(path.join(projectDir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Bash(git status *)"] } }),
    );
    expect(detectLadderState(projectDir).rungs.permissions).toBe(true);
  });

  it("detects commands from .claude/commands/*.md", () => {
    fs.mkdirSync(path.join(projectDir, ".claude", "commands"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, ".claude", "commands", "deploy.md"), "do the deploy");
    expect(detectLadderState(projectDir).rungs.commands).toBe(true);
  });

  it("detects skills from .claude/skills/<name>/SKILL.md", () => {
    fs.mkdirSync(path.join(projectDir, ".claude", "skills", "check"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, ".claude", "skills", "check", "SKILL.md"), "---\nname: check\n---\nbody");
    expect(detectLadderState(projectDir).rungs.skills).toBe(true);
  });

  it("does not count a skill directory missing SKILL.md", () => {
    fs.mkdirSync(path.join(projectDir, ".claude", "skills", "incomplete"), { recursive: true });
    expect(detectLadderState(projectDir).rungs.skills).toBe(false);
  });

  it("detects helpers from nested .claude/agents/ subfolders (Claude Code scans recursively)", () => {
    fs.mkdirSync(path.join(projectDir, ".claude", "agents", "review"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, ".claude", "agents", "review", "reviewer.md"), "---\nname: reviewer\n---\n");
    expect(detectLadderState(projectDir).rungs.helpers).toBe(true);
  });

  it("detects tools from project .mcp.json", () => {
    fs.writeFileSync(path.join(projectDir, ".mcp.json"), JSON.stringify({ mcpServers: { foo: { command: "foo" } } }));
    expect(detectLadderState(projectDir).rungs.tools).toBe(true);
  });

  it("detects tools from a user-scope server at the top level of ~/.claude.json", () => {
    fs.writeFileSync(path.join(fakeHome, ".claude.json"), JSON.stringify({ mcpServers: { serena: { command: "serena" } } }));
    expect(detectLadderState(projectDir).rungs.tools).toBe(true);
  });

  it("detects tools from a local-scope server keyed by project path in ~/.claude.json", () => {
    const realProjectDir = fs.realpathSync(projectDir);
    fs.writeFileSync(
      path.join(fakeHome, ".claude.json"),
      JSON.stringify({ projects: { [realProjectDir]: { mcpServers: { db: { command: "db" } } } } }),
    );
    expect(detectLadderState(projectDir).rungs.tools).toBe(true);
  });

  it("detects automatic checks from hooks in user-scope settings.json", () => {
    fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] } }),
    );
    expect(detectLadderState(projectDir).rungs.automaticChecks).toBe(true);
  });

  it("does not count an empty hooks object as automatic checks", () => {
    fs.mkdirSync(path.join(projectDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, ".claude", "settings.json"), JSON.stringify({ hooks: {} }));
    expect(detectLadderState(projectDir).rungs.automaticChecks).toBe(false);
  });

  it("detects memory from an explicit autoCompactWindow key", () => {
    fs.mkdirSync(path.join(projectDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, ".claude", "settings.json"), JSON.stringify({ autoCompactWindow: 150000 }));
    expect(detectLadderState(projectDir).rungs.memory).toBe(true);
  });

  it("detects memory from a name-only skillOverrides entry", () => {
    fs.mkdirSync(path.join(projectDir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, ".claude", "settings.local.json"),
      JSON.stringify({ skillOverrides: { doctor: "name-only" } }),
    );
    expect(detectLadderState(projectDir).rungs.memory).toBe(true);
  });

  it("never reports parallel work as on — no filesystem signal exists for it in v1", () => {
    expect(detectLadderState(projectDir).rungs.parallelWork).toBe(false);
  });

  it("does not crash on malformed JSON, and records a parse warning instead of guessing", () => {
    fs.mkdirSync(path.join(projectDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, ".claude", "settings.json"), "{ this is not json,,, ");
    const state = detectLadderState(projectDir);
    expect(state.rungs.permissions).toBe(false);
    expect(state.parseWarnings).toContain(path.join(projectDir, ".claude", "settings.json"));
  });

  it("does not treat a missing settings file as a parse warning", () => {
    const state = detectLadderState(projectDir);
    expect(state.parseWarnings).toEqual([]);
  });
});
