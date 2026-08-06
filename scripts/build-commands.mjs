#!/usr/bin/env node
/**
 * Maintainer helper: pairs the official command list with the hand-written
 * plain-English wording in scripts/command-wording.mjs and emits
 * src/data/commands.json.
 *
 * It never invents wording. A command with no hand-written entry falls back to
 * the official description, trimmed, and is flagged `needsWording` so the gap
 * is visible instead of silently shipping documentation prose.
 */
import fs from "node:fs";
import path from "node:path";
import { WORDING, CATEGORIES } from "./command-wording.mjs";

const src = process.argv[2];
if (!src) { console.error("usage: build-commands.mjs <official-commands.md>"); process.exit(1); }

const rows = [];
for (const line of fs.readFileSync(src, "utf8").split("\n")) {
  const m = /^\|\s*`(\/[^`]+)`\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
  if (!m) continue;
  let desc = m[2].replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/`([^`]*)`/g, "$1")
                 .replace(/\\\|/g, "|").replace(/\*\*/g, "").trim();
  const raw = m[1];
  const name = raw.split(" ")[0];
  const args = raw.slice(name.length).trim() || null;
  rows.push({ name, args, official: desc });
}

const commands = [];
const missing = [];
for (const r of rows) {
  const removed = /^Removed(\.| in )/i.test(r.official);
  const w = WORDING[r.name];
  if (!w && !removed) missing.push(r.name);
  const firstSentence = r.official.split(/\.\s/)[0].replace(/\.$/, "");
  commands.push({
    name: r.name,
    args: r.args,
    // A removed command always sorts into "Gone now", even if it still has
    // hand-written wording from when it worked.
    category: removed ? "Gone now" : (w?.category ?? "Everything else"),
    plain: w?.plain ?? firstSentence.slice(0, 70),
    why: w?.why ?? null,
    costsTokens: w?.costsTokens ?? false,
    isSkill: /^Skill\./i.test(r.official),
    removed,
    needsWording: !w && !removed,
    official: r.official,
  });
}

const order = new Map(CATEGORIES.map((c, i) => [c, i]));
commands.sort((a, b) =>
  (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99) || a.name.localeCompare(b.name));

const out = {
  generated: new Date().toISOString().slice(0, 10),
  sourceUrl: "https://code.claude.com/docs/en/commands",
  note: "Built only from the official commands page. Community lists contain commands that do not exist.",
  categories: CATEGORIES,
  commands,
};
fs.writeFileSync(path.resolve("src/data/commands.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${commands.length} commands; ${missing.length} still need hand-written wording`);
if (missing.length) console.log("  " + missing.join(" "));
