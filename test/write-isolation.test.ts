import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * §7.1: "core/write.ts is the only file permitted to call fs.writeFile.
 * Enforce with a lint rule." This is that rule — a test rather than an ESLint
 * plugin, so it runs in the same command as everything else and can't be
 * skipped by a formatter config.
 */

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

const MUTATING_CALLS = [
  "writeFileSync",
  "writeFile",
  "appendFileSync",
  "appendFile",
  "mkdirSync",
  "renameSync",
  "unlinkSync",
  "rmSync",
  "chmodSync",
  "copyFileSync",
  "openSync",
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("write isolation (§7.1)", () => {
  it("only core/write.ts mutates the filesystem", () => {
    const offenders: string[] = [];

    for (const file of walk(srcDir)) {
      if (file.endsWith(path.join("core", "write.ts"))) continue;
      const text = fs.readFileSync(file, "utf8");
      for (const call of MUTATING_CALLS) {
        if (new RegExp(`\\bfs\\.${call}\\s*\\(`).test(text)) {
          offenders.push(`${path.relative(srcDir, file)} calls fs.${call}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
