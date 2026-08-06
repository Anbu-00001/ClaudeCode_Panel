import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KIT_ORDER, getKit, installKit, isKitInstalled, loadKits, previewKit, uninstallKit } from "../src/core/kits.js";
import { resolvePaths } from "../src/core/paths.js";
import { appendUndoEntry } from "../src/core/undo.js";
import { serializeJson } from "../src/core/write.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedirMock = vi.fn(actual.homedir);
  return { ...actual, homedir: homedirMock, default: { ...actual, homedir: homedirMock } };
});

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KITS = path.join(projectRoot, "kits");

let repoDir: string;
let fakeHome: string;

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-m4-"));
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-m4h-"));
  vi.mocked(os.homedir).mockReturnValue(fakeHome);
  execSync("git init -q .", { cwd: repoDir });
});

afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

const repo = () => resolvePaths(repoDir);
const kit = (id: string) => getKit(id, KITS)!;

describe("the kit library", () => {
  it("loads all four kits", () => {
    const ids = loadKits(KITS).map((k) => k.id);
    expect(ids).toContain("deletion-warning");
    expect(ids).toContain("code-reviewer");
    expect(ids).toContain("browser-testing");
    expect(ids).toContain("voice-input");
  });

  it("puts the deletion warning first, as §9.5 requires", () => {
    expect(loadKits(KITS)[0]?.id).toBe("deletion-warning");
    expect(KIT_ORDER[0]).toBe("deletion-warning");
  });

  it("every kit says which newcomer problem it solves", () => {
    for (const k of loadKits(KITS)) {
      expect(k.newcomerProblem, `${k.id} is missing newcomerProblem`).toBeTruthy();
    }
  });

  it("no kit description uses jargon a beginner would have to look up", () => {
    const banned = ["MCP", "subagent", "hook", "settings.json", "frontmatter", "stdio", "JSON"];
    for (const k of loadKits(KITS)) {
      const text = `${k.title} ${k.blurb} ${k.explain}`;
      for (const word of banned) {
        expect(text.includes(word), `${k.id} says "${word}"`).toBe(false);
      }
    }
  });

  it("every kit is honest about what it can't do", () => {
    for (const k of loadKits(KITS)) {
      expect(k.honestLimit, `${k.id} has no honestLimit`).toBeTruthy();
    }
  });
});

describe("code-reviewer: the files-only install path", () => {
  it("installs a helper and an ability, and allows the git commands they need", () => {
    const result = installKit(kit("code-reviewer"), repo(), appendUndoEntry);
    expect(result.ok).toBe(true);

    expect(fs.existsSync(path.join(repoDir, ".claude", "agents", "reviewer.md"))).toBe(true);
    expect(fs.existsSync(path.join(repoDir, ".claude", "skills", "check", "SKILL.md"))).toBe(true);

    const local = JSON.parse(fs.readFileSync(path.join(repoDir, ".claude", "settings.local.json"), "utf8"));
    expect(local.permissions.allow).toContain("Bash(git diff *)");
  });

  it("ships a subagent with the frontmatter Claude Code requires", () => {
    const text = fs.readFileSync(path.join(KITS, "code-reviewer", "agents", "reviewer.md"), "utf8");
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toMatch(/^name: reviewer$/m);
    expect(text).toMatch(/^description: .+/m);
  });

  it("ships a skill that only the user can trigger, since it costs tokens", () => {
    const text = fs.readFileSync(path.join(KITS, "code-reviewer", "skills", "check", "SKILL.md"), "utf8");
    expect(text).toMatch(/^name: check$/m);
    expect(text).toMatch(/^disable-model-invocation: true$/m);
  });

  it("uninstalls cleanly, leaving unrelated permissions alone", () => {
    const localPath = path.join(repoDir, ".claude", "settings.local.json");
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, serializeJson({ permissions: { allow: ["Bash(mine *)"] } }));

    installKit(kit("code-reviewer"), repo(), appendUndoEntry);
    expect(uninstallKit(kit("code-reviewer"), repo(), appendUndoEntry).ok).toBe(true);

    expect(fs.existsSync(path.join(repoDir, ".claude", "agents", "reviewer.md"))).toBe(false);
    const after = JSON.parse(fs.readFileSync(localPath, "utf8"));
    expect(after.permissions.allow).toEqual(["Bash(mine *)"]);
  });
});

describe("browser-testing: the MCP install path", () => {
  it("writes the server into .mcp.json using the official package", () => {
    expect(installKit(kit("browser-testing"), repo(), appendUndoEntry).ok).toBe(true);

    const mcp = JSON.parse(fs.readFileSync(path.join(repoDir, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.playwright.command).toBe("npx");
    expect(mcp.mcpServers.playwright.args).toContain("@playwright/mcp@latest");
    expect(mcp.mcpServers.playwright.type).toBe("stdio");
  });

  it("is detected as installed from the server entry, since it creates no files", () => {
    expect(isKitInstalled(kit("browser-testing"), repo())).toBe(false);
    installKit(kit("browser-testing"), repo(), appendUndoEntry);
    expect(isKitInstalled(kit("browser-testing"), repo())).toBe(true);
  });

  it("removes only its own server on uninstall", () => {
    fs.writeFileSync(
      path.join(repoDir, ".mcp.json"),
      serializeJson({ mcpServers: { mine: { command: "my-server" } } }),
    );

    installKit(kit("browser-testing"), repo(), appendUndoEntry);
    uninstallKit(kit("browser-testing"), repo(), appendUndoEntry);

    const mcp = JSON.parse(fs.readFileSync(path.join(repoDir, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.mine).toBeDefined();
    expect(mcp.mcpServers.playwright).toBeUndefined();
  });

  it("previews the change without writing anything", () => {
    const preview = previewKit(kit("browser-testing"), repo());
    expect(preview.lines).toHaveLength(1);
    expect(fs.existsSync(path.join(repoDir, ".mcp.json"))).toBe(false);
  });
});

describe("voice-input: talking instead of typing", () => {
  it("installs a runnable shortcut and an ability that explains it", () => {
    expect(installKit(kit("voice-input"), repo(), appendUndoEntry).ok).toBe(true);

    const script = path.join(repoDir, ".claude", "scripts", "talk.sh");
    expect(fs.existsSync(script)).toBe(true);
    expect(fs.statSync(script).mode & 0o111).not.toBe(0);
    expect(fs.existsSync(path.join(repoDir, ".claude", "skills", "talk", "SKILL.md"))).toBe(true);
  });

  it("tells the user what to install rather than changing their computer", () => {
    installKit(kit("voice-input"), repo(), appendUndoEntry);
    const script = path.join(repoDir, ".claude", "scripts", "talk.sh");
    const out = execSync(`bash ${JSON.stringify(script)} check 2>&1 || true`, { encoding: "utf8" });

    // On a machine without dictation it must explain, not crash.
    expect(out.length).toBeGreaterThan(0);
    const body = fs.readFileSync(script, "utf8");
    expect(body).not.toContain("sudo apt install -y");
    expect(body).not.toContain("curl -fsSL");
  });

  it("says plainly that it can't add a button inside Claude Code", () => {
    expect(kit("voice-input").honestLimit).toContain("doesn't add a microphone button");
  });
});
