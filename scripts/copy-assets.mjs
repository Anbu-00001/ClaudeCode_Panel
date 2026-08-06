#!/usr/bin/env node
/**
 * tsc emits only JavaScript, so the hand-written data files in src/data are
 * left behind and the built app cannot find them. Without this the published
 * package crashes the moment you open the Commands screen.
 */
import fs from "node:fs";
import path from "node:path";

const from = path.resolve("src/data");
const to = path.resolve("dist/data");
fs.mkdirSync(to, { recursive: true });

let n = 0;
for (const file of fs.readdirSync(from)) {
  if (!file.endsWith(".json")) continue;
  fs.copyFileSync(path.join(from, file), path.join(to, file));
  n += 1;
}
console.log(`copied ${n} data file${n === 1 ? "" : "s"} to dist/data`);
