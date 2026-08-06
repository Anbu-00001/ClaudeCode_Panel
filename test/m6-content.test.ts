import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { daysSinceGenerated, groupByCategory, isStale, loadCommands, searchCommands } from "../src/core/commands.js";
import { loadExplain } from "../src/core/explain.js";
import { getKit, loadKits } from "../src/core/kits.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const library = loadCommands();

describe("the command library (§11.2)", () => {
  it("ships every command from the official page", () => {
    expect(library.commands.length).toBeGreaterThanOrEqual(100);
    expect(library.sourceUrl).toBe("https://code.claude.com/docs/en/commands");
  });

  it("contains no command that community lists invented", () => {
    // §11.2: a widely-shared "complete list" contains these; none exist.
    const fabricated = ["/godmode", "/beastmode", "/ghost", "/punch", "/mirror", "/approve", "/skip"];
    const names = new Set(library.commands.map((c) => c.name.toLowerCase()));
    for (const fake of fabricated) expect(names.has(fake), `ships ${fake}`).toBe(false);
  });

  it("has hand-written wording for every command", () => {
    const missing = library.commands.filter((c) => c.needsWording).map((c) => c.name);
    expect(missing).toEqual([]);
  });

  it("keeps every plain description short and free of jargon", () => {
    for (const c of library.commands) {
      expect(c.plain.length, `${c.name}: "${c.plain}"`).toBeLessThanOrEqual(60);
      for (const jargon of ["token", "MCP", "subagent", "settings.json", "stdio"]) {
        expect(c.plain.toLowerCase().includes(jargon.toLowerCase()), `${c.name} says ${jargon}`).toBe(false);
      }
    }
  });

  it("names the situation in every why, as a sentence", () => {
    for (const c of library.commands) {
      if (!c.why) continue;
      expect(c.why.endsWith("."), `${c.name}`).toBe(true);
    }
  });

  it("flags the commands that spend money", () => {
    const compact = library.commands.find((c) => c.name === "/compact");
    expect(compact?.costsTokens).toBe(true);
    expect(library.commands.filter((c) => c.costsTokens).length).toBeGreaterThan(10);
  });

  it("keeps removed commands findable but out of the way", () => {
    const removed = library.commands.filter((c) => c.removed);
    expect(removed.length).toBeGreaterThan(0);
    for (const c of removed) expect(c.category).toBe("Gone now");
    // and they never appear in an empty-query browse
    expect(searchCommands(library, "").some((c) => c.removed)).toBe(false);
  });

  it("groups everything into the spec's categories", () => {
    const groups = groupByCategory(library);
    expect(groups.map((g) => g.category)).toContain("Saving money");
    expect(groups.reduce((n, g) => n + g.commands.length, 0)).toBe(library.commands.length);
  });
});

describe("searching", () => {
  it("puts the exact command first", () => {
    expect(searchCommands(library, "/compact")[0]?.name).toBe("/compact");
    expect(searchCommands(library, "compact")[0]?.name).toBe("/compact");
  });

  it("finds things by what you want, not just by name", () => {
    expect(searchCommands(library, "money").length).toBeGreaterThan(3);
    expect(searchCommands(library, "forgetting").some((c) => c.name === "/compact")).toBe(true);
    expect(searchCommands(library, "undo").some((c) => c.name === "/rewind")).toBe(true);
  });

  it("returns nothing rather than nonsense for gibberish", () => {
    expect(searchCommands(library, "zzzqqqxyz")).toEqual([]);
  });

  it("notices when the list is getting old (§11.3)", () => {
    expect(isStale(library, new Date(library.generated))).toBe(false);
    const later = new Date(new Date(library.generated).getTime() + 61 * 86_400_000);
    expect(isStale(library, later)).toBe(true);
    expect(daysSinceGenerated(library, later)).toBe(61);
  });
});

describe("the teaching content (§11.1)", () => {
  const entries = loadExplain();

  it("covers every rung of the ladder", () => {
    expect(entries.length).toBe(11);
    for (const id of ["helpers", "tools", "automaticChecks", "memory", "skills"]) {
      expect(entries.some((e) => e.id === id), id).toBe(true);
    }
  });

  it("keeps every sentence under 20 words", () => {
    for (const e of entries) {
      for (const field of ["oneLine", "whatItIs", "whenYouWantIt", "example"] as const) {
        for (const sentence of e[field].split(/(?<=[.!?])\s+/)) {
          expect(sentence.split(/\s+/).length, `${e.id}.${field}: "${sentence}"`).toBeLessThanOrEqual(20);
        }
      }
    }
  });

  it("never uses a word the reader would have to look up", () => {
    for (const e of entries) {
      const text = [e.oneLine, e.whatItIs, e.whenYouWantIt, e.example].join(" ").toLowerCase();
      for (const jargon of ["mcp", "subagent", "frontmatter", "settings.json", "token", "scope", "json"]) {
        expect(text.includes(jargon), `${e.id} says "${jargon}"`).toBe(false);
      }
    }
  });

  it("points every kit reference at a kit that exists", () => {
    const ids = new Set(loadKits(path.join(projectRoot, "kits")).map((k) => k.id));
    for (const e of entries) {
      if (e.kitId) expect(ids.has(e.kitId), `${e.id} -> ${e.kitId}`).toBe(true);
    }
  });

  it("links to the official docs for every capability", () => {
    for (const e of entries) expect(e.docsUrl.startsWith("https://code.claude.com/")).toBe(true);
  });
});

describe("the refresh script (§11.3)", () => {
  it("never writes to the shipped command list", () => {
    const before = fs.readFileSync(path.join(projectRoot, "src/data/commands.json"));
    const source = fs.readFileSync(path.join(projectRoot, "scripts/refresh-commands.mjs"), "utf8");
    // It must have no way to write the file at all.
    expect(source).not.toMatch(/writeFileSync\(\s*["'`].*commands\.json/);
    expect(fs.readFileSync(path.join(projectRoot, "src/data/commands.json"))).toEqual(before);
  });
});

describe("the kit Claude asked for", () => {
  const kit = getKit("own-mistakes", path.join(projectRoot, "kits"))!;

  it("exists and says why Claude wanted it", () => {
    expect(kit).toBeDefined();
    expect((kit as unknown as { chosenByClaude?: boolean }).chosenByClaude).toBe(true);
    expect((kit as unknown as { whyClaudeWantsThis?: string }).whyClaudeWantsThis?.length ?? 0).toBeGreaterThan(80);
  });

  it("hands problems back to Claude rather than to the user", () => {
    const hook = fs.readFileSync(path.join(projectRoot, "kits/own-mistakes/hooks/check-my-work.sh"), "utf8");
    expect(hook).toContain("additionalContext");
    expect(hook).toContain("PostToolUse");
  });

  it("warns when a file is generated, and stays silent otherwise", () => {
    const hookPath = path.join(projectRoot, "kits/own-mistakes/hooks/check-my-work.sh");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-om-"));
    fs.writeFileSync(path.join(tmp, "gen.ts"), "// @generated DO NOT EDIT\nexport const x = 1;\n");
    fs.writeFileSync(path.join(tmp, "plain.md"), "just notes\n");

    const run = (f: string) =>
      execFileSync("bash", [hookPath], {
        input: JSON.stringify({ tool_name: "Edit", cwd: tmp, tool_input: { file_path: path.join(tmp, f) } }),
        encoding: "utf8", timeout: 20_000,
      });

    expect(run("gen.ts")).toContain("generated");
    expect(run("plain.md").trim()).toBe("");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("never installs anything or guesses at a checker", () => {
    const hook = fs.readFileSync(path.join(projectRoot, "kits/own-mistakes/hooks/check-my-work.sh"), "utf8");
    for (const forbidden of ["npm install", "pip install", "curl ", "apt install", "sudo "]) {
      expect(hook.includes(forbidden), `hook runs "${forbidden}"`).toBe(false);
    }
  });
});
