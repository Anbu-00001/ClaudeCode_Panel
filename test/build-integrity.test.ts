import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The built package must actually run. tsc emits only JavaScript, so the
 * hand-written data files were silently left out of dist/ and the published
 * app crashed on the Commands screen — while every test still passed, because
 * tests import from src/. This checks the artifact people install.
 */
describe("the built package", () => {
  it("ships the data files the app reads at runtime", () => {
    execFileSync("npm", ["run", "build"], { cwd: root, stdio: "pipe" });
    for (const file of fs.readdirSync(path.join(root, "src", "data"))) {
      if (!file.endsWith(".json")) continue;
      expect(fs.existsSync(path.join(root, "dist", "data", file)), `dist/data/${file}`).toBe(true);
    }
  }, 180_000);

  it("loads every screen's data from dist without throwing", () => {
    const probe = `
      const { loadCommands } = await import("${path.join(root, "dist/core/commands.js")}");
      const { loadExplain } = await import("${path.join(root, "dist/core/explain.js")}");
      const { loadKits } = await import("${path.join(root, "dist/core/kits.js")}");
      const c = loadCommands(), e = loadExplain(), k = loadKits();
      if (!c.commands.length || !e.length || !k.length) throw new Error("empty data");
      console.log("ok");
    `;
    const out = execFileSync("node", ["--input-type=module", "-e", probe], {
      cwd: root, encoding: "utf8", timeout: 60_000,
    });
    expect(out.trim()).toBe("ok");
  }, 60_000);

  it("declares the kits directory so it reaches the published package", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.files).toContain("kits");
    expect(pkg.files).toContain("dist");
  });
});
