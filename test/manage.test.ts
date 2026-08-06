import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePaths } from "../src/core/paths.js";
import { STATE_CYCLE, STATE_LABEL, listSkills, nextState, readFrontmatter, stateOf } from "../src/core/skills.js";
import { setConnectorsEnabled, setSkillState, setToolEnabled } from "../src/core/toggles.js";
import { connectorsDisabled, listTools } from "../src/core/tools.js";
import { readUndoLogNewestFirst } from "../src/core/undo.js";
import { maskText } from "../src/core/mask.js";
import { serializeJson } from "../src/core/write.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedirMock = vi.fn(actual.homedir);
  return { ...actual, homedir: homedirMock, default: { ...actual, homedir: homedirMock } };
});

let repoDir: string;
let fakeHome: string;
const repo = () => resolvePaths(repoDir);
const localSettings = () => path.join(repoDir, ".claude", "settings.local.json");
const readLocal = () => JSON.parse(fs.readFileSync(localSettings(), "utf8"));

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-mg-"));
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-mgh-"));
  vi.mocked(os.homedir).mockReturnValue(fakeHome);
  execSync("git init -q .", { cwd: repoDir });
});
afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

function makeSkill(dir: string, name: string, frontmatter: string, body = "do things") {
  const d = path.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
}

describe("finding abilities", () => {
  it("reads name and description from the frontmatter", () => {
    makeSkill(path.join(repoDir, ".claude", "skills"), "deploy",
      'name: deploy\ndescription: Ship the app to production. Use when releasing.');
    const skills = listSkills(repo());
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("deploy");
    expect(skills[0]?.description).toContain("Ship the app");
    expect(skills[0]?.source).toBe("project");
  });

  it("survives a skill whose frontmatter is broken", () => {
    const d = path.join(repoDir, ".claude", "skills", "broken");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "SKILL.md"), "---\nname: [unclosed\n---\nbody\n");
    expect(() => listSkills(repo())).not.toThrow();
    expect(listSkills(repo())[0]?.name).toBe("broken"); // falls back to the folder name
  });

  it("handles a description containing a colon, which naive parsing breaks on", () => {
    makeSkill(path.join(repoDir, ".claude", "skills"), "note",
      'name: note\ndescription: "Use this: it handles colons, quotes and commas"');
    expect(listSkills(repo())[0]?.description).toBe("Use this: it handles colons, quotes and commas");
  });

  it("reports how much of Claude's memory each one costs, in words not money", () => {
    makeSkill(path.join(repoDir, ".claude", "skills"), "tiny", "name: tiny\ndescription: Short one.");
    makeSkill(path.join(repoDir, ".claude", "skills"), "huge",
      `name: huge\ndescription: ${"a very long description ".repeat(30)}`);
    const skills = listSkills(repo());
    expect(skills.find((s) => s.name === "tiny")?.weight).toBe("a little");
    expect(skills.find((s) => s.name === "huge")?.weight).toBe("a lot");
    for (const s of skills) expect(String(s.weight)).not.toMatch(/\$|\d/);
  });

  it("notices a skill that already only runs when asked", () => {
    makeSkill(path.join(repoDir, ".claude", "skills"), "commit",
      "name: commit\ndescription: Write a message.\ndisable-model-invocation: true");
    expect(listSkills(repo())[0]?.disablesModelInvocation).toBe(true);
  });
});

describe("acceptance #8: an ability cycles all four states", () => {
  beforeEach(() => {
    makeSkill(path.join(repoDir, ".claude", "skills"), "deploy", "name: deploy\ndescription: Ship it.");
  });

  it("writes the right value for each state, and starts at on", () => {
    expect(stateOf({}, "deploy")).toBe("on");

    const seen: string[] = [];
    let state = stateOf({}, "deploy");
    for (let i = 0; i < 4; i++) {
      state = nextState(state);
      expect(setSkillState(repo(), "deploy", state).ok).toBe(true);
      const overrides = readLocal().skillOverrides;
      if (state === "on") {
        // "on" is the absence of an entry, not a written value.
        expect(overrides?.deploy).toBeUndefined();
      } else {
        expect(overrides.deploy).toBe(state);
      }
      seen.push(state);
    }
    expect(seen).toEqual(["name-only", "user-invocable-only", "off", "on"]);
  });

  it("cycles through exactly the four documented states", () => {
    expect(STATE_CYCLE).toEqual(["on", "name-only", "user-invocable-only", "off"]);
    expect(Object.values(STATE_LABEL)).toEqual(["On", "Quiet", "Only when you ask", "Off"]);
  });

  it("never shows the raw setting name to the user", () => {
    for (const label of Object.values(STATE_LABEL)) {
      expect(label).not.toContain("skillOverrides");
      expect(label).not.toMatch(/name-only|user-invocable-only/);
    }
  });

  it("leaves unrelated settings untouched", () => {
    fs.mkdirSync(path.dirname(localSettings()), { recursive: true });
    fs.writeFileSync(localSettings(), serializeJson({ permissions: { allow: ["Bash(ls)"] }, mine: 1 }));
    setSkillState(repo(), "deploy", "off");
    const after = readLocal();
    expect(after.permissions.allow).toEqual(["Bash(ls)"]);
    expect(after.mine).toBe(1);
    expect(after.skillOverrides.deploy).toBe("off");
  });

  it("records each change so it can be undone", () => {
    setSkillState(repo(), "deploy", "off");
    const entry = readUndoLogNewestFirst()[0];
    expect(entry?.label).toContain("deploy");
    expect(entry?.changes[0]?.key).toContain("skillOverrides");
  });
});

describe("acceptance #9: things we cannot honestly switch", () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(repoDir, ".mcp.json"),
      serializeJson({ mcpServers: { playwright: { command: "npx", args: ["-y", "@playwright/mcp"] } } }));
    fs.writeFileSync(path.join(fakeHome, ".claude.json"),
      serializeJson({ mcpServers: { serena: { command: "serena", args: ["start"] } } }));
  });

  it("marks a user-scope tool read-only and offers the real command instead", () => {
    const tools = listTools(repo());
    const userTool = tools.find((t) => t.name === "serena");
    expect(userTool?.scope).toBe("user");
    expect(userTool?.switchable).toBe(false);
    expect(userTool?.removeCommand).toBe("claude mcp remove serena -s user");
  });

  it("writes nothing at all for a user-scope tool", () => {
    const before = fs.readFileSync(path.join(fakeHome, ".claude.json"));
    const settingsExisted = fs.existsSync(localSettings());
    // The screen never calls a writer for these, so nothing should exist after.
    expect(listTools(repo()).find((t) => t.name === "serena")?.switchable).toBe(false);
    expect(fs.readFileSync(path.join(fakeHome, ".claude.json"))).toEqual(before);
    expect(fs.existsSync(localSettings())).toBe(settingsExisted);
  });

  it("switches a project tool off and on again through the documented setting", () => {
    expect(listTools(repo()).find((t) => t.name === "playwright")?.switchable).toBe(true);

    expect(setToolEnabled(repo(), "playwright", false).ok).toBe(true);
    expect(readLocal().disabledMcpjsonServers).toEqual(["playwright"]);
    expect(listTools(repo()).find((t) => t.name === "playwright")?.enabled).toBe(false);

    expect(setToolEnabled(repo(), "playwright", true).ok).toBe(true);
    expect(readLocal().disabledMcpjsonServers).toBeUndefined();
    expect(listTools(repo()).find((t) => t.name === "playwright")?.enabled).toBe(true);
  });

  it("never writes ~/.claude.json, which holds the sign-in session", () => {
    const before = fs.readFileSync(path.join(fakeHome, ".claude.json"));
    setToolEnabled(repo(), "playwright", false);
    setSkillState(repo(), "anything", "off");
    setConnectorsEnabled(repo(), false);
    expect(fs.readFileSync(path.join(fakeHome, ".claude.json"))).toEqual(before);
  });

  it("treats claude.ai connectors as one shared switch", () => {
    expect(connectorsDisabled(repo())).toBe(false);
    expect(setConnectorsEnabled(repo(), false).ok).toBe(true);
    expect(readLocal().disableClaudeAiConnectors).toBe(true);
    expect(connectorsDisabled(repo())).toBe(true);
  });
});

describe("bundled abilities are not ours to switch", () => {
  it("marks a plugin skill unswitchable and points at /plugin", () => {
    const install = path.join(fakeHome, ".claude", "plugins", "cache", "mk", "demo", "1.0.0");
    fs.mkdirSync(path.join(install, "skills"), { recursive: true });
    makeSkill(path.join(install, "skills"), "bundled", "name: bundled\ndescription: From a bundle.");
    fs.mkdirSync(path.join(fakeHome, ".claude", "plugins"), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, ".claude", "plugins", "installed_plugins.json"),
      serializeJson({ version: 2, plugins: { "demo@mk": [{ scope: "user", installPath: install }] } }));

    const skill = listSkills(repo()).find((s) => s.name === "bundled");
    expect(skill?.source).toBe("plugin");
    expect(skill?.switchable).toBe(false);
    expect(skill?.pluginId).toBe("demo@mk");
  });
});

describe("secrets never reach the screen", () => {
  it("masks a credential in a tool's start command", () => {
    fs.writeFileSync(path.join(repoDir, ".mcp.json"), serializeJson({
      mcpServers: { db: { command: "npx", args: ["-y", "srv", "--token", "sk-ant-secret123456"] } },
    }));
    const tool = listTools(repo()).find((t) => t.name === "db");
    expect(maskText(tool?.summary ?? "")).not.toContain("sk-ant-secret123456");
  });
});
