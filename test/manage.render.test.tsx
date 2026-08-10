import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { render } from "ink-testing-library";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePaths } from "../src/core/paths.js";
import { Manage } from "../src/screens/Manage.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedirMock = vi.fn(actual.homedir);
  return { ...actual, homedir: homedirMock, default: { ...actual, homedir: homedirMock } };
});

let repoDir: string;
let fakeHome: string;

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-mr-"));
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-mrh-"));
  vi.mocked(os.homedir).mockReturnValue(fakeHome);
  execSync("git init -q .", { cwd: repoDir });
});
afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

function makeSkill(name: string, frontmatter: string) {
  const d = path.join(repoDir, ".claude", "skills", name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "SKILL.md"), `---\n${frontmatter}\n---\n\nbody\n`);
}

/** The freshness check is async, so the screen paints before it lands. */
const settle = () => new Promise((r) => setTimeout(r, 120));

describe("the manage screen, rendered", () => {
  it("shows a switch for a user-scope tool instead of calling it read-only", async () => {
    fs.writeFileSync(
      path.join(fakeHome, ".claude.json"),
      JSON.stringify({ mcpServers: { serena: { command: "serena" } } }),
    );
    const { lastFrame, unmount } = render(
      <Manage repo={resolvePaths(repoDir)} onOpenKits={() => {}} onBack={() => {}} />,
    );
    await settle();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("serena");
    expect(frame).toContain("turn off");
    // The old copy promised the opposite; make sure it can't come back.
    expect(frame).not.toContain("can't be switched here");
    unmount();
  });

  it("offers an update key for an ability and never guesses its freshness", async () => {
    makeSkill("deploy", "name: deploy\ndescription: Ship it.");
    const { lastFrame, stdin, unmount } = render(
      <Manage repo={resolvePaths(repoDir)} onOpenKits={() => {}} onBack={() => {}} />,
    );
    await settle();
    stdin.write("[C"); // right arrow, over to abilities
    await settle();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("deploy");
    expect(frame).toContain("u");
    // A hand-made skill has no update source, so the screen must say it can't
    // tell rather than claiming the skill is current.
    expect(frame).not.toContain("Up to date");
    unmount();
  });

  it("explains why instead of doing nothing when there is no way to update", async () => {
    makeSkill("deploy", "name: deploy\ndescription: Ship it.");
    const { lastFrame, stdin, unmount } = render(
      <Manage repo={resolvePaths(repoDir)} onOpenKits={() => {}} onBack={() => {}} />,
    );
    await settle();
    stdin.write("[C");
    await settle();
    stdin.write("u");
    await settle();

    const frame = lastFrame() ?? "";
    expect(frame.toLowerCase()).toContain("nothing on this computer records where this skill came from");
    unmount();
  });
});
