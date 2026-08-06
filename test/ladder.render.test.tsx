import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import { Ladder } from "../src/screens/Ladder.js";
import type { LadderState, RungId } from "../src/core/detect.js";

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

describe("Ladder screen", () => {
  it("shows the project name, the running count, and checkmarks only for rungs that are on", () => {
    const state = makeState(["instructions", "permissions", "tools"]);
    const { lastFrame } = render(<Ladder state={state} />);
    const frame = lastFrame() ?? "";

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

  it("leads with 'Start here' and a single suggestion when nothing is configured", () => {
    const state = makeState([]);
    const { lastFrame } = render(<Ladder state={state} />);
    const frame = lastFrame() ?? "";

    expect(frame).toContain("Start here — it takes about a minute.");
    expect(frame).toContain("Claude knows your project");
  });

  it("never shows a config key, file path, or jargon term in the main view", () => {
    const state = makeState(["instructions"]);
    const { lastFrame } = render(<Ladder state={state} />);
    const frame = lastFrame() ?? "";

    for (const bannedTerm of ["settings.json", "skillOverrides", "MCP", "subagent", ".claude/"]) {
      expect(frame).not.toContain(bannedTerm);
    }
  });
});
