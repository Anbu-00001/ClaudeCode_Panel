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
