#!/usr/bin/env node
/**
 * Puts `ccpanel` on your PATH so you can run it in any folder.
 *
 * Why a script instead of one npm command:
 *
 * `npm install -g .` looks like the obvious answer, but npm treats a local
 * folder as a *link*: it drops a symlink to this checkout into the global
 * node_modules instead of copying anything. That is fine for developing the
 * package and wrong for using it. It means the command you type in some other
 * folder runs whatever is in dist/ at that instant — so a half-finished edit,
 * a failed build or a `git clean` breaks a command you were relying on. It
 * also means the `files` list in package.json is never exercised, so a file
 * missing from it only fails later, for whoever installs from the registry.
 *
 * So this packs the real tarball (exactly the files that would be published)
 * and installs that. The global copy is a snapshot: independent of the
 * checkout, and proof that the published package will work too. Re-run this
 * script to pick up changes.
 *
 * Nothing here needs sudo. npm's global folder lives inside your Node
 * installation, which for nvm and most other version managers is under your
 * home directory and already writable.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(args, options = {}) {
  const result = spawnSync(npm, args, { cwd: root, stdio: "inherit", ...options });
  if (result.status !== 0) {
    // Surface npm's own message rather than a wrapper's, and stop: a partial
    // install is worse than none.
    process.exit(result.status ?? 1);
  }
  return result;
}

console.log("Building…");
run(["run", "build"]);

// Pack into a scratch folder so a stray .tgz never lands in the repo.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-install-"));
try {
  console.log("Packing…");
  // npm prints its progress notices on stderr and the tarball name on stdout.
  const packed = execFileSync(npm, ["pack", "--pack-destination", stage], {
    cwd: root,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .pop();
  const tarball = path.join(stage, (packed ?? "").trim());
  if (!fs.existsSync(tarball)) {
    throw new Error(`npm pack did not produce a tarball (looked for ${tarball})`);
  }

  console.log("Installing…");
  run(["install", "-g", tarball]);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}

// Tell the truth about whether the command is actually reachable. npm can
// install happily into a folder that is not on PATH, and then `ccpanel` just
// says "command not found" with no clue why.
const prefix = execFileSync(npm, ["prefix", "-g"], { encoding: "utf8" }).trim();
const binDir = process.platform === "win32" ? prefix : path.join(prefix, "bin");
const command = path.join(binDir, "ccpanel");
const onPath = (process.env["PATH"] ?? "").split(path.delimiter).includes(binDir);

console.log("");
if (!fs.existsSync(command)) {
  console.log(`Installed, but ${command} isn't there. Something went wrong — nothing to run yet.`);
  process.exitCode = 1;
} else if (onPath) {
  console.log("Done. Type this in any folder:");
  console.log("");
  console.log("  ccpanel");
  console.log("");
  console.log(`(it lives at ${command})`);
} else {
  console.log(`Installed to ${command}, but that folder isn't on your PATH,`);
  console.log("so typing `ccpanel` won't find it yet. Add this line to your shell startup file");
  console.log("(~/.bashrc or ~/.zshrc) and open a new terminal:");
  console.log("");
  console.log(`  export PATH="${binDir}:$PATH"`);
}
