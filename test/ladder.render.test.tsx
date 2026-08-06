import { render } from "ink-testing-library";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { describe, expect, it } from "vitest";
import type { LadderState, RungId } from "../src/core/detect.js";
import { loadKits } from "../src/core/kits.js";
import { Ladder } from "../src/screens/Ladder.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kits = loadKits(path.join(projectRoot, "kits"));

function makeState(on: RungId[]): LadderState {
  const rungs = {
    instructions: false,
    permissions: false,
    commands: false,
    skills: false,
    helpers: false,
    tools: false,
    automaticChecks: false,
    memory: false,
    parallelWork: false,
  } as Record<RungId, boolean>;
  for (const r of on) rungs[r] = true;
  return {
    rungs,
    countOn: on.length,
    countTotal: 9,
    parseWarnings: [],
    repo: {
      cwd: "/home/u/my-website",
      isGitRepo: true,
      gitRoot: "/home/u/my-website",
      projectDir: "/home/u/my-website",
      ancestorDirs: ["/home/u/my-website"],
    },
  };
}

function renderLadder(on: RungId[]) {
  return render(<Ladder state={makeState(on)} kits={kits} onOpenKits={() => {}} />);
}

describe("Ladder screen", () => {
  it("shows the project name, the running count, and checkmarks only for rungs that are on", () => {
    const frame = renderLadder(["instructions", "permissions", "tools"]).lastFrame() ?? "";

    expect(frame).toContain("ccpanel · my-website");
    expect(frame).toContain("You're using");
    expect(frame).toContain("3");
    expect(frame).toContain("9 things");
    expect(frame).toContain("✓ Project instructions");
    expect(frame).toContain("✓ Permissions");
    expect(frame).toContain("✓ Tools");
    expect(frame).toContain("· Commands");
    expect(frame).toContain("· Helpers");
  });

  it("leads with 'Start here' when nothing is configured", () => {
    const frame = renderLadder([]).lastFrame() ?? "";
    expect(frame).toContain("Start here — it takes about a minute.");
  });

  it("suggests a real bundled kit the project doesn't have yet", () => {
    const frame = renderLadder([]).lastFrame() ?? "";
    expect(frame).toContain("Claude warns you before deleting anything big");
  });

  it("describes whatever is under the cursor, so arrowing explains without opening", () => {
    const frame = renderLadder([]).lastFrame() ?? "";
    // The first suggestion starts highlighted, so its blurb is on screen.
    expect(frame).toContain("Claude stops and checks with you first");
  });

  it("never shows a config key, file path, or jargon term in the main view", () => {
    const frame = renderLadder(["instructions"]).lastFrame() ?? "";
    for (const banned of ["settings.json", "skillOverrides", "MCP", "subagent", ".claude/", "PreToolUse"]) {
      expect(frame).not.toContain(banned);
    }
  });
});
