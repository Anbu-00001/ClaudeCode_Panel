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

/**
 * The help for the one failure people actually hit: Node installed system-wide
 * (a distro package, the official .pkg), so npm's global folder belongs to
 * root. The common advice is to install as root, which runs a package's
 * install scripts as root too; pointing npm at a folder in your own home is
 * the safer fix.
 */
const EACCES_HELP = [
  "",
  "npm wasn't allowed to write to its global folder. That usually means Node was",
  "installed for the whole system, so the folder belongs to the administrator.",
  "Rather than installing as the administrator, point npm at a folder in your",
  "home and run this again:",
  "",
  "  npm config set prefix ~/.local",
  "",
  "and make sure that folder's bin is on your PATH (add to ~/.bashrc or ~/.zshrc):",
  "",
  '  export PATH="$HOME/.local/bin:$PATH"',
].join("\n");

/** Runs `npm install -g`, returning null on success or the exit code to leave with. */
function installGlobally(tarball) {
  // stderr is captured (and echoed) so a permissions failure can be spotted.
  const result = spawnSync(npm, ["install", "-g", tarball], {
    cwd: root,
    stdio: ["inherit", "inherit", "pipe"],
    encoding: "utf8",
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status === 0) return null;
  if (/EACCES|EPERM|permission denied/i.test(result.stderr ?? "")) console.error(EACCES_HELP);
  return result.status ?? 1;
}

let installFailed = null;

console.log("Building…");
run(["run", "build"]);

// Pack into a scratch folder so a stray .tgz never lands in the repo.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-install-"));
try {
  console.log("Packing…");
  // npm prints its progress notices on stderr and the tarball name on stdout.
  // --ignore-scripts: prepack would only rebuild what was built a moment ago.
  const packed = execFileSync(npm, ["pack", "--ignore-scripts", "--pack-destination", stage], {
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
  installFailed = installGlobally(tarball);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
if (installFailed !== null) process.exit(installFailed);

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
