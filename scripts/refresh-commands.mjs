#!/usr/bin/env node
/**
 * MAINTAINER TOOL — never run on a user's machine (§11.3).
 *
 * Fetches the official commands page, compares it with what we ship, and
 * PRINTS A DIFF for a human to read. It does not write anything, on purpose:
 * `plain` and `why` are hand-written, and a scraper would replace all of them
 * with documentation prose.
 */
import fs from "node:fs";

const SOURCE = "https://code.claude.com/docs/en/commands.md";

const current = JSON.parse(fs.readFileSync("src/data/commands.json", "utf8"));
const ours = new Map(current.commands.map((c) => [c.name, c]));

console.log(`Ours was generated ${current.generated}. Fetching ${SOURCE} …\n`);

let text;
try {
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  text = await res.text();
} catch (err) {
  console.error(`Could not fetch the docs: ${err.message}`);
  process.exit(1);
}

const live = new Map();
for (const line of text.split("\n")) {
  const m = /^\|\s*`(\/[^`]+)`\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
  if (!m) continue;
  const name = m[1].split(" ")[0];
  live.set(name, m[2].replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/`([^`]*)`/g, "$1").trim());
}

const added = [...live.keys()].filter((n) => !ours.has(n));
const gone = [...ours.keys()].filter((n) => !live.has(n));
const nowRemoved = [...live.entries()]
  .filter(([n, d]) => /^Removed(\.| in )/i.test(d) && ours.get(n) && !ours.get(n).removed)
  .map(([n]) => n);

console.log(`Official page lists ${live.size} commands; we ship ${ours.size}.\n`);

if (added.length) {
  console.log("NEW — need hand-written wording in scripts/command-wording.mjs:");
  for (const n of added) console.log(`  + ${n}  — ${live.get(n).slice(0, 90)}`);
  console.log();
}
if (gone.length) {
  console.log("NO LONGER ON THE PAGE — check before deleting:");
  for (const n of gone) console.log(`  - ${n}`);
  console.log();
}
if (nowRemoved.length) {
  console.log("NEWLY MARKED REMOVED upstream:");
  for (const n of nowRemoved) console.log(`  ! ${n}`);
  console.log();
}
const needWording = current.commands.filter((c) => c.needsWording);
if (needWording.length) {
  console.log(`${needWording.length} shipped commands still lack hand-written wording:`);
  console.log("  " + needWording.map((c) => c.name).join(" ") + "\n");
}

if (!added.length && !gone.length && !nowRemoved.length && !needWording.length) {
  console.log("No changes. Nothing to do.");
} else {
  console.log("Nothing was written. Edit scripts/command-wording.mjs by hand,");
  console.log("then run: node scripts/build-commands.mjs <path-to-commands.md>");
}
