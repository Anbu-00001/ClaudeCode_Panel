import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bundledKitsDir,
  getKit,
  installKit,
  isKitInstalled,
  loadKits,
  previewKit,
  uninstallKit,
  verifyDeletionWarning,
} from "../src/core/kits.js";
import { resolvePaths } from "../src/core/paths.js";
import { appendUndoEntry, readUndoLogNewestFirst } from "../src/core/undo.js";
import { serializeJson } from "../src/core/write.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedirMock = vi.fn(actual.homedir);
  return { ...actual, homedir: homedirMock, default: { ...actual, homedir: homedirMock } };
});

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let repoDir: string;
let fakeHome: string;

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-kit-"));
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-kh-"));
  vi.mocked(os.homedir).mockReturnValue(fakeHome);
  execSync("git init -q .", { cwd: repoDir });
});

afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

function repo() {
  return resolvePaths(repoDir);
}

describe("kit loading", () => {
  it("loads the bundled deletion-warning kit", () => {
    const kits = loadKits(path.join(projectRoot, "kits"));
    expect(kits.length).toBeGreaterThan(0);
    expect(kits.find((k) => k.id === "deletion-warning")).toBeDefined();
  });

  it("resolves the bundled kits directory from the module location", () => {
    expect(fs.existsSync(bundledKitsDir())).toBe(true);
  });

  it("skips a malformed kit instead of crashing the app", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-badkits-"));
    fs.mkdirSync(path.join(dir, "broken"), { recursive: true });
    fs.writeFileSync(path.join(dir, "broken", "kit.json"), "{ not json");
    fs.mkdirSync(path.join(dir, "wrong-shape"), { recursive: true });
    fs.writeFileSync(path.join(dir, "wrong-shape", "kit.json"), JSON.stringify({ id: "x" }));

    expect(loadKits(dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("preview (C5)", () => {
  it("lists every file created and every setting changed, before anything happens", () => {
    const kit = getKit("deletion-warning", path.join(projectRoot, "kits"));
    const preview = previewKit(kit!, repo());

    expect(preview.lines.map((l) => l.op)).toContain("create");
    expect(preview.lines.map((l) => l.op)).toContain("change");
    expect(preview.lines.some((l) => l.displayPath.includes("warn-before-delete.sh"))).toBe(true);
    expect(preview.files.length).toBeGreaterThan(0);

    // Nothing was written just by previewing.
    expect(fs.existsSync(path.join(repoDir, ".claude"))).toBe(false);
  });

  it("describes settings changes in plain language, not key names", () => {
    const kit = getKit("deletion-warning", path.join(projectRoot, "kits"));
    const change = previewKit(kit!, repo()).lines.find((l) => l.op === "change");
    expect(change?.note).toBeTruthy();
    expect(change?.note).not.toContain("hooks");
    expect(change?.note).not.toContain("PreToolUse");
  });
});

describe("install and uninstall", () => {
  function kit() {
    return getKit("deletion-warning", path.join(projectRoot, "kits"))!;
  }

  it("installs the script as executable and patches the settings", () => {
    const result = installKit(kit(), repo(), appendUndoEntry);
    expect(result.ok).toBe(true);

    const script = path.join(repoDir, ".claude", "hooks", "warn-before-delete.sh");
    expect(fs.existsSync(script)).toBe(true);
    expect(fs.statSync(script).mode & 0o111).not.toBe(0);

    const settings = JSON.parse(
      fs.readFileSync(path.join(repoDir, ".claude", "settings.json"), "utf8"),
    );
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Bash|Edit|Write");
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("${CLAUDE_PROJECT_DIR}");
  });

  it("acceptance #11: detects an already-installed kit rather than duplicating it", () => {
    installKit(kit(), repo(), appendUndoEntry);
    expect(isKitInstalled(kit(), repo())).toBe(true);

    installKit(kit(), repo(), appendUndoEntry);
    const settings = JSON.parse(
      fs.readFileSync(path.join(repoDir, ".claude", "settings.json"), "utf8"),
    );
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });

  it("acceptance #2: uninstall removes everything it added and nothing else", () => {
    const settingsPath = path.join(repoDir, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      serializeJson({
        permissions: { allow: ["Bash(ls)"] },
        somethingCcpanelNeverHeardOf: { deep: [1, 2] },
        hooks: {
          PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "mine.sh" }] }],
        },
      }),
    );

    installKit(kit(), repo(), appendUndoEntry);
    const un = uninstallKit(kit(), repo(), appendUndoEntry);
    expect(un.ok).toBe(true);

    expect(fs.existsSync(path.join(repoDir, ".claude", "hooks", "warn-before-delete.sh"))).toBe(false);

    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(after.permissions.allow).toEqual(["Bash(ls)"]);
    expect(after.somethingCcpanelNeverHeardOf).toEqual({ deep: [1, 2] });
    expect(after.hooks.PostToolUse).toHaveLength(1);
    expect(after.hooks.PreToolUse).toBeUndefined();
  });

  it("leaves a user's own PreToolUse hook in place when uninstalling", () => {
    const settingsPath = path.join(repoDir, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      serializeJson({
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "theirs.sh" }] }] },
      }),
    );

    installKit(kit(), repo(), appendUndoEntry);
    uninstallKit(kit(), repo(), appendUndoEntry);

    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(after.hooks.PreToolUse).toHaveLength(1);
    expect(after.hooks.PreToolUse[0].hooks[0].command).toBe("theirs.sh");
  });

  it("records the install as one undo entry", () => {
    installKit(kit(), repo(), appendUndoEntry);
    const entries = readUndoLogNewestFirst();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toContain("Claude warns you before deleting");
    expect(entries[0]?.changes.length).toBeGreaterThan(1);
  });

  it("rolls back completely when a settings file is unparseable", () => {
    const settingsPath = path.join(repoDir, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, "{ broken,,,");
    const before = fs.readFileSync(settingsPath);

    const result = installKit(kit(), repo(), appendUndoEntry);

    expect(result.ok).toBe(false);
    expect(result.failure?.reason).toBe("unparseable");
    expect(fs.readFileSync(settingsPath)).toEqual(before);
    // The script created in step 1 must be gone again.
    expect(fs.existsSync(path.join(repoDir, ".claude", "hooks", "warn-before-delete.sh"))).toBe(false);
    expect(readUndoLogNewestFirst()).toHaveLength(0);
  });
});

describe("post-install self-check (§9.5)", () => {
  function kit() {
    return getKit("deletion-warning", path.join(projectRoot, "kits"))!;
  }

  it("passes on a healthy install and confirms a test warning fired", () => {
    installKit(kit(), repo(), appendUndoEntry);
    const verify = verifyDeletionWarning(kit(), repo());
    expect(verify.ok).toBe(true);
    expect(verify.checks.find((c) => c.label === "A test warning worked")?.ok).toBe(true);
  });

  it("acceptance #15: catches a script that isn't executable instead of silently installing something inert", () => {
    installKit(kit(), repo(), appendUndoEntry);
    const script = path.join(repoDir, ".claude", "hooks", "warn-before-delete.sh");
    fs.chmodSync(script, 0o644);

    const verify = verifyDeletionWarning(kit(), repo());

    expect(verify.ok).toBe(false);
    const check = verify.checks.find((c) => c.label === "It's allowed to run");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("never start");
  });

  it("warns when disableAllHooks would stop it from ever running", () => {
    installKit(kit(), repo(), appendUndoEntry);
    fs.writeFileSync(
      path.join(repoDir, ".claude", "settings.local.json"),
      serializeJson({ disableAllHooks: true }),
    );

    const verify = verifyDeletionWarning(kit(), repo());

    expect(verify.ok).toBe(false);
    expect(verify.checks.find((c) => c.label === "Automatic checks are switched on")?.ok).toBe(false);
  });

  it("reports a missing file rather than claiming success", () => {
    const verify = verifyDeletionWarning(kit(), repo());
    expect(verify.ok).toBe(false);
    expect(verify.checks.find((c) => c.label === "The file is in place")?.ok).toBe(false);
  });
});
