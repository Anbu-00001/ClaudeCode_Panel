import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKit } from "../src/core/kits.js";
import { resolvePaths } from "../src/core/paths.js";
import { KitDetail } from "../src/screens/KitDetail.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedirMock = vi.fn(actual.homedir);
  return { ...actual, homedir: homedirMock, default: { ...actual, homedir: homedirMock } };
});

const kitsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "kits");

let repoDir: string;
let fakeHome: string;

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-kd-"));
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-kdh-"));
  vi.mocked(os.homedir).mockReturnValue(fakeHome);
  execSync("git init -q .", { cwd: repoDir });
});
afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

const settle = () => new Promise((r) => setTimeout(r, 60));

function show(kitId: string) {
  const kit = getKit(kitId, kitsDir);
  if (!kit) throw new Error(`no kit ${kitId}`);
  return render(<KitDetail kit={kit} repo={resolvePaths(repoDir)} onBack={() => {}} />);
}

describe("the kit screen, after setting a kit up", () => {
  it("doesn't run the deletion warning's self-test for some other kit", async () => {
    const { lastFrame, stdin, unmount } = show("scope-guard");
    await settle();
    stdin.write("\r"); // "Set it up" is first
    await settle();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Done.");
    expect(frame).not.toContain("big deletions");
    expect(frame).not.toContain("A test warning worked");
    expect(frame).not.toContain("✗");
    unmount();
  });

  it("still runs the self-test for the deletion warning itself", async () => {
    const { lastFrame, stdin, unmount } = show("deletion-warning");
    await settle();
    stdin.write("\r");
    await settle();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("big deletions");
    expect(frame).toContain("A test warning worked");
    unmount();
  });
});

describe("the kit screen, for a kit that is already set up", () => {
  it("highlights the choice that changes nothing, so Enter can't remove it", async () => {
    const kit = getKit("scope-guard", kitsDir);
    if (!kit) throw new Error("no kit");
    const { installKit } = await import("../src/core/kits.js");
    installKit(kit, resolvePaths(repoDir));
    const hook = path.join(repoDir, ".claude", "hooks", "guard-important-files.sh");
    expect(fs.existsSync(hook)).toBe(true);

    let wentBack = false;
    const { lastFrame, stdin, unmount } = render(
      <KitDetail kit={kit} repo={resolvePaths(repoDir)} onBack={() => (wentBack = true)} />,
    );
    await settle();
    expect(lastFrame() ?? "").toContain("Keep it");
    stdin.write("\r");
    await settle();

    expect(wentBack).toBe(true);
    expect(fs.existsSync(hook)).toBe(true);
    unmount();
  });
});

const DOWN = "\u001B[B";

describe("the kit screen shows exactly what it does", () => {
  it("lists the exact rules and hook commands, not just a summary", async () => {
    const { previewKit } = await import("../src/core/kits.js");
    const repo = resolvePaths(repoDir);
    const perms = previewKit(getKit("safe-permissions", kitsDir)!, repo);
    const details = perms.lines.flatMap((l) => l.details ?? []).join("\n");
    expect(details).toContain("Runs without asking: Bash(git status *), Bash(git diff *)");
    expect(details).toContain("Always asks you first: Bash(git diff *--output*)");

    const hook = previewKit(getKit("deletion-warning", kitsDir)!, repo);
    expect(hook.lines.flatMap((l) => l.details ?? []).join("\n")).toContain(
      'Runs before Claude uses a tool (Bash|Edit|Write): "$CLAUDE_PROJECT_DIR"/.claude/hooks/warn-before-delete.sh',
    );

    const { lastFrame, unmount } = show("deletion-warning");
    await settle();
    expect(lastFrame() ?? "").toContain("warn-before-delete.sh");
    unmount();
  });

  it("scrolls through the whole of a long file instead of cutting it off", async () => {
    const { lastFrame, stdin, unmount } = show("deletion-warning");
    await settle();
    stdin.write(DOWN); // "Show me the files"
    await settle();
    stdin.write("\r");
    await settle();
    expect(lastFrame() ?? "").toMatch(/Lines 1–\d+ of \d+ · \d+ more below/);

    stdin.write(DOWN);
    await settle();
    expect(lastFrame() ?? "").toMatch(/Lines 2–/);
    stdin.write("\u001B[6~"); // PgDn
    await settle();
    expect(lastFrame() ?? "").not.toMatch(/Lines [12]–/);
    unmount();
  });
});

describe("removing a kit asks first, listing what goes", () => {
  it("shows what will be removed and does nothing until confirmed", async () => {
    const kit = getKit("scope-guard", kitsDir)!;
    const { installKit } = await import("../src/core/kits.js");
    installKit(kit, resolvePaths(repoDir));
    const hook = path.join(repoDir, ".claude", "hooks", "guard-important-files.sh");

    const { lastFrame, stdin, unmount } = render(
      <KitDetail kit={kit} repo={resolvePaths(repoDir)} onBack={() => {}} />,
    );
    await settle();
    stdin.write(DOWN);
    await settle();
    stdin.write(DOWN); // "Remove it"
    await settle();
    stdin.write("\r");
    await settle();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Removing it will:");
    expect(frame).toContain(".claude/hooks/guard-important-files.sh");
    expect(frame).toContain("No, keep it");
    expect(fs.existsSync(hook)).toBe(true);

    stdin.write("\r"); // "No, keep it" is highlighted first
    await settle();
    expect(fs.existsSync(hook)).toBe(true);
    expect(lastFrame() ?? "").not.toContain("Removing it will:");

    stdin.write("\r"); // back on "Remove it"
    await settle();
    stdin.write(DOWN);
    await settle();
    stdin.write("\r"); // "Yes, remove it"
    await settle();
    expect(fs.existsSync(hook)).toBe(false);
    unmount();
  });
});
