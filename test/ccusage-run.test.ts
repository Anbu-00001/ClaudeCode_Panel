import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _clearCacheForTests, ccusageRunDir, getUsage } from "../src/core/ccusage.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedirMock = vi.fn(actual.homedir);
  return { ...actual, homedir: homedirMock, default: { ...actual, homedir: homedirMock } };
});

let fakeHome: string;
let project: string;
let binDir: string;
const saved = {
  cwd: process.cwd(),
  path: process.env["PATH"],
  reg: process.env["npm_config_registry"],
};

beforeEach(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-cch-"));
  project = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-ccp-"));
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-ccb-"));
  vi.mocked(os.homedir).mockReturnValue(fakeHome);
  _clearCacheForTests();

  // A hostile project: its own ccusage, and an .npmrc pointing elsewhere.
  const planted = path.join(project, "node_modules", ".bin");
  fs.mkdirSync(planted, { recursive: true });
  fs.writeFileSync(
    path.join(planted, "ccusage"),
    `#!/bin/sh\ntouch "${project}/PWNED"\necho '{"daily":[]}'\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(project, ".npmrc"), "registry=https://evil.example/\n");

  // Stands in for npx: reports where it ran and which registry it was told
  // to use, and runs a local ccusage if one is in reach — as npx would.
  fs.writeFileSync(
    path.join(binDir, "npx"),
    [
      "#!/bin/sh",
      "if [ -x ./node_modules/.bin/ccusage ]; then ./node_modules/.bin/ccusage; exit 0; fi",
      'printf \'{"daily":[{"date":"%s|%s|%s","totalCost":1}]}\' "$(pwd -P)" "$npm_config_registry" "$npm_config_userconfig"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  process.env["PATH"] = `${binDir}${path.delimiter}${saved.path ?? ""}`;
  process.env["npm_config_registry"] = "https://also-evil.example/";
  process.chdir(project);
});

afterEach(() => {
  process.chdir(saved.cwd);
  process.env["PATH"] = saved.path;
  if (saved.reg === undefined) delete process.env["npm_config_registry"];
  else process.env["npm_config_registry"] = saved.reg;
  for (const d of [fakeHome, project, binDir]) fs.rmSync(d, { recursive: true, force: true });
});

describe("ccusage runs away from the project folder", () => {
  it("never runs a ccusage planted in the project, and pins the public registry", async () => {
    const outcome = await getUsage("daily");
    expect(fs.existsSync(path.join(project, "PWNED"))).toBe(false);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const [cwd, registry, userconfig] = (outcome.report.rows[0]?.label ?? "").split("|");
    expect(cwd).toBe(fs.realpathSync(ccusageRunDir()));
    expect(registry).toBe("https://registry.npmjs.org/");
    expect(fs.readFileSync(userconfig as string, "utf8")).toBe("");
  });
});
