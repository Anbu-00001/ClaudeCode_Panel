import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  bin: Record<string, string>;
  files: string[];
  scripts: Record<string, string>;
};

/**
 * `ccpanel` is meant to be typed in any folder, not only in this one. That
 * turns three things into promises the build has to keep, and none of them
 * fail loudly on their own — they fail later, on someone else's computer, in
 * a folder nobody tested:
 *
 *  1. `bin` has to point at a file the build actually produces. A stale path
 *     here means `ccpanel` is "installed" and then says "command not found".
 *  2. `files` has to cover everything the app reads at runtime. The app finds
 *     its kits and its data relative to its own location, so anything left
 *     out of the package is missing at exactly the moment it is needed.
 *  3. `dist/cli.js` has to start with a shebang. Without one the shell runs it
 *     as a shell script and it dies on the first `import`.
 *
 * These are checked against the real packed package, not against src/.
 */

interface PackedFile {
  path: string;
  mode: number;
}

let packed: PackedFile[];

beforeAll(() => {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "pipe" });
  // --dry-run writes no tarball but reports exactly the files one would hold,
  // which is the only honest way to ask "would this reach the user's machine".
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  packed = (JSON.parse(out) as Array<{ files: PackedFile[] }>)[0]?.files ?? [];
  expect(packed.length).toBeGreaterThan(0);
}, 180_000);

const inPackage = (p: string): boolean => packed.some((f) => f.path === p);

describe("the ccpanel command", () => {
  it("is the only bin, and is named ccpanel", () => {
    expect(Object.keys(pkg.bin)).toEqual(["ccpanel"]);
  });

  it("points at a file the build produces", () => {
    const binPath = pkg.bin["ccpanel"] as string;
    // Must live in the build output, not in src/ — src is TypeScript and is
    // not shipped, so a bin pointing there installs a command that cannot run.
    expect(binPath.replace(/^\.\//, "").startsWith("dist/")).toBe(true);

    const source = path.join(root, "src", "cli.tsx");
    expect(fs.existsSync(source), "src/cli.tsx is what tsc compiles to the bin").toBe(true);

    const built = path.resolve(root, binPath);
    expect(fs.existsSync(built), `${binPath} after npm run build`).toBe(true);
  });

  it("is runnable, in the build output and in the package", () => {
    const built = path.resolve(root, pkg.bin["ccpanel"] as string);
    // npm sets the bit when it links a bin, but a file that is only executable
    // by npm's good grace is not a file you can run.
    expect(fs.statSync(built).mode & 0o111).toBeGreaterThan(0);

    const entry = packed.find((f) => f.path === "dist/cli.js");
    expect(entry, "dist/cli.js is in the package").toBeDefined();
    expect((entry as PackedFile).mode & 0o111).toBeGreaterThan(0);
  });

  it("starts with a shebang on the very first line", () => {
    const built = path.resolve(root, pkg.bin["ccpanel"] as string);
    const contents = fs.readFileSync(built, "utf8");
    // Not "contains" and not "the first non-empty line" — the kernel only
    // honours #! at byte zero. tsc keeps it there today; this notices if a
    // future compiler option hoists anything above it.
    expect(contents.startsWith("#!")).toBe(true);
    expect(contents.split("\n", 1)[0]).toBe("#!/usr/bin/env node");
  });
});

describe("the packaged files the command needs at runtime", () => {
  it("ships every compiled module, not just the entry point", () => {
    const missing: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".js")) continue;
        const rel = path.relative(root, full);
        if (!inPackage(rel)) missing.push(rel);
      }
    };
    walk(path.join(root, "dist"));
    expect(missing).toEqual([]);
  });

  it("ships the data JSON the Commands and Explore screens require", () => {
    // src/core/commands.ts reaches for ../data/commands.json relative to its
    // own compiled location, so the JSON has to sit beside the JavaScript in
    // the package — tsc alone never puts it there.
    const dataFiles = fs
      .readdirSync(path.join(root, "src", "data"))
      .filter((f) => f.endsWith(".json"));
    expect(dataFiles.length).toBeGreaterThan(0);
    for (const file of dataFiles) {
      expect(inPackage(`dist/data/${file}`), `dist/data/${file}`).toBe(true);
    }
  });

  it("ships every kit, including the files each kit installs", () => {
    // bundledKitsDir() resolves <package>/kits from the compiled module's own
    // URL, so kits/ must be in the package at the top level — and a kit whose
    // manifest ships without its hook script is a kit that fails on install,
    // in someone else's folder, after they pressed Enter.
    const kitsDir = path.join(root, "kits");
    const kitIds = fs
      .readdirSync(kitsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(kitIds.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const id of kitIds) {
      const manifestRel = `kits/${id}/kit.json`;
      if (!inPackage(manifestRel)) {
        missing.push(manifestRel);
        continue;
      }
      const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestRel), "utf8")) as {
        installs?: Array<{ from?: string }>;
      };
      for (const entry of manifest.installs ?? []) {
        if (typeof entry.from !== "string") continue;
        const rel = `kits/${id}/${entry.from}`;
        if (!inPackage(rel)) missing.push(rel);
      }
    }
    expect(missing).toEqual([]);
  });

  it("does not ship the source tree or the tests", () => {
    // Not size for its own sake: src/ in the package means two copies of the
    // app on disk and a real chance of debugging the wrong one.
    const strays = packed.filter(
      (f) => f.path.startsWith("src/") || f.path.startsWith("test/"),
    );
    expect(strays.map((f) => f.path)).toEqual([]);
  });
});

describe("installing the command", () => {
  it("has a script to put it on PATH and one to take it off again", () => {
    // Reversible, like everything else here: anything that can be installed
    // has to be removable by the person who installed it.
    expect(pkg.scripts["install-global"]).toBeDefined();
    expect(pkg.scripts["uninstall-global"]).toBeDefined();
    expect(fs.existsSync(path.join(root, "scripts", "install-global.mjs"))).toBe(true);
  });

  it("never asks for sudo", () => {
    // npm's global folder is inside the Node install, which for nvm and
    // friends is already yours. A tool that tells a beginner to type sudo has
    // taught them the wrong reflex.
    for (const [name, body] of Object.entries(pkg.scripts)) {
      expect(body, `script "${name}"`).not.toMatch(/\bsudo\b/);
    }
    // Comments are allowed to say the word — the code is not allowed to run it.
    const code = fs
      .readFileSync(path.join(root, "scripts", "install-global.mjs"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bsudo\b/);
  });
});
