import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  notATerminalMessage,
  parseLaunchArgs,
  readVersion,
  sizeProblem,
} from "../src/core/launch.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

/** Runs the real entry point with stdin and stdout piped, as a script or CI would. */
function cli(...args: string[]) {
  return spawnSync(path.join(root, "node_modules", ".bin", "tsx"), ["src/cli.tsx", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("starting ccpanel", () => {
  it("reads flags", () => {
    expect(parseLaunchArgs([])).toEqual({ kind: "run" });
    expect(parseLaunchArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseLaunchArgs(["-h"])).toEqual({ kind: "help" });
    expect(parseLaunchArgs(["--version"])).toEqual({ kind: "version" });
    expect(parseLaunchArgs(["--frobnicate"])).toEqual({ kind: "unknown", arg: "--frobnicate" });
  });

  it("reports the version from package.json", () => {
    expect(readVersion()).toBe(pkgVersion);
  });

  it("names both size limits and which one the window misses", () => {
    expect(sizeProblem(80, 24)).toBeNull();
    expect(sizeProblem(70, 30)).toBe(
      "ccpanel needs a window at least 80 columns wide and 24 rows tall. This one is 70 columns wide, so make it wider.",
    );
    expect(sizeProblem(100, 20)).toContain("This one is 20 rows tall, so make it taller.");
    expect(sizeProblem(60, 10)).toContain(
      "60 columns wide and 10 rows tall, so make it wider and taller",
    );
  });

  it("explains, rather than crashing, when it isn't in a terminal", () => {
    expect(notATerminalMessage(true, true)).toBeNull();
    expect(notATerminalMessage(false, true)).toContain("has to run directly in a terminal");
  });

  it("prints its version and help, and exits 1 with a message when piped", () => {
    const version = cli("--version");
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(pkgVersion);

    const help = cli("--help");
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("ccpanel --version");

    const piped = cli();
    expect(piped.status).toBe(1);
    expect(piped.stderr).toContain("has to run directly in a terminal");
    expect(piped.stderr).not.toContain("Raw mode");

    const unknown = cli("--frobnicate");
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('doesn\'t know "--frobnicate"');
  }, 60_000);
});
