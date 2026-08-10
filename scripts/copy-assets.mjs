#!/usr/bin/env node
/**
 * Post-build fixups for things `tsc` does not do.
 *
 * 1. tsc emits only JavaScript, so the hand-written data files in src/data are
 *    left behind and the built app cannot find them. Without this the published
 *    package crashes the moment you open the Commands screen.
 * 2. tsc keeps the `#!/usr/bin/env node` shebang but emits the file 0644, so
 *    `./dist/cli.js` is not runnable on its own. npm happens to fix the mode
 *    when it links a bin, but anyone running the file directly (or unpacking
 *    the tarball by hand) gets "Permission denied". Set the bit here so the
 *    build output is correct on its own terms.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve against this script, not the shell's cwd, so the build works no
// matter where it is invoked from.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "src", "data");
const to = path.join(root, "dist", "data");
fs.mkdirSync(to, { recursive: true });

let n = 0;
for (const file of fs.readdirSync(from)) {
  if (!file.endsWith(".json")) continue;
  fs.copyFileSync(path.join(from, file), path.join(to, file));
  n += 1;
}
console.log(`copied ${n} data file${n === 1 ? "" : "s"} to dist/data`);

const cli = path.join(root, "dist", "cli.js");
const firstLine = fs.readFileSync(cli, "utf8").split("\n", 1)[0];
if (!firstLine.startsWith("#!")) {
  // A missing shebang means `ccpanel` would be handed to the shell instead of
  // node. Fail the build rather than ship a command that cannot start.
  throw new Error(`dist/cli.js lost its shebang (first line: ${JSON.stringify(firstLine)})`);
}
fs.chmodSync(cli, 0o755);
console.log("made dist/cli.js executable");
