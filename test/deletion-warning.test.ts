import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Acceptance tests #12-#17 for kit #11 (§14).
 *
 * The silences are tested as hard as the alerts: alert fatigue is the failure
 * mode for this feature, so a false positive is a bug of the same weight as a
 * miss.
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(projectRoot, "kits", "deletion-warning", "hooks", "warn-before-delete.sh");

let repo: string;

function run(
  payload: unknown,
  cwd = repo,
  env: NodeJS.ProcessEnv = process.env,
): { stdout: string; code: number } {
  try {
    const stdout = execFileSync("bash", [HOOK], {
      input: typeof payload === "string" ? payload : JSON.stringify(payload),
      cwd,
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? "", code: e.status ?? 1 };
  }
}

function bash(payload: string, cwd = repo, env: NodeJS.ProcessEnv = process.env) {
  return run({ tool_name: "Bash", tool_input: { command: payload } }, cwd, env);
}

/** The human-readable reason, with the JSON escapes for newlines undone. */
function reasonOf(out: { stdout: string }): string {
  return (/"permissionDecisionReason":"((?:[^"\\]|\\.)*)"/.exec(out.stdout)?.[1] ?? "").replace(
    /\\n/g,
    "\n",
  );
}

function warns(out: { stdout: string }): boolean {
  return out.stdout.includes('"permissionDecision":"ask"');
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-dw-"));
  execSync("git init -q . && git config user.email t@t && git config user.name t", { cwd: repo });
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  for (let i = 1; i <= 12; i++) {
    fs.writeFileSync(path.join(repo, "src", `file${i}.ts`), `export const v${i} = ${i};\n`);
  }
  fs.mkdirSync(path.join(repo, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules", "pkg", "index.js"), "module.exports={}\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  execSync("git add src .gitignore && git commit -qm init", { cwd: repo });
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("acceptance #12: warns and names the unsaved count", () => {
  it("warns on rm -rf src/ when there are uncommitted changes, naming how many", () => {
    fs.appendFileSync(path.join(repo, "src", "file1.ts"), "// edited\n");

    const out = bash("rm -rf src/");

    expect(warns(out)).toBe(true);
    expect(out.stdout).toContain("12 files");
    expect(out.stdout).toMatch(/1 of them has changes that aren't saved in git/);
  });

  it("is quieter when everything is already committed", () => {
    const out = bash("rm -rf src/");
    expect(out.stdout).toContain("saved in git, so you could get it back");
  });
});

describe("acceptance #13: the silences", () => {
  it("does NOT warn on rm -rf node_modules/", () => {
    const out = bash("rm -rf node_modules/");
    expect(warns(out)).toBe(false);
    expect(out.stdout.trim()).toBe("");
  });

  for (const cmd of [
    "rm -rf dist/",
    "rm -rf build/",
    "rm -rf .next/",
    "rm -rf target/",
    "rm -rf __pycache__/",
    "rm -rf /tmp/scratch",
    "rm src/file1.ts",
    "ls -la",
    "git status",
    "npm install",
    "git commit -m 'x'",
  ]) {
    it(`does NOT warn on: ${cmd}`, () => {
      expect(warns(bash(cmd))).toBe(false);
    });
  }

  it("does not warn on an ordinary file edit", () => {
    const out = run({
      tool_name: "Edit",
      tool_input: { file_path: path.join(repo, "src/file1.ts") },
    });
    expect(warns(out)).toBe(false);
  });

  it("ignores tools it does not police", () => {
    expect(warns(run({ tool_name: "Read", tool_input: { file_path: "/etc/passwd" } }))).toBe(false);
  });
});

describe("the alerts", () => {
  const loud: Array<[string, string]> = [
    ["rm -rf /", "whole home folder"],
    ["rm -rf ~", "whole home folder"],
    ["git reset --hard", "uncommitted changes"],
    ["git clean -fd", "uncommitted changes"],
    ["psql -c 'DROP TABLE users'", "database table"],
    ["psql -c 'DROP DATABASE production'", "database table or a whole database"],
    ["psql -c 'TRUNCATE TABLE orders'", "database"],
    ["psql -c 'DELETE FROM users;'", "every row"],
    ["terraform destroy", "infrastructure"],
    ["kubectl delete pod api", "infrastructure"],
    ["docker system prune -a", "infrastructure"],
    ["dd if=/dev/zero of=/dev/sda", "disk"],
    ["mkfs.ext4 /dev/sdb1", "disk"],
    ["git push --force origin main", "shared branch"],
  ];

  for (const [cmd, expected] of loud) {
    it(`warns on: ${cmd}`, () => {
      if (cmd.startsWith("git reset") || cmd.startsWith("git clean")) {
        fs.appendFileSync(path.join(repo, "src", "file1.ts"), "// edited\n");
      }
      const out = bash(cmd);
      expect(warns(out)).toBe(true);
      expect(out.stdout).toContain(expected);
    });
  }

  it("stays quiet on git reset --hard when there is nothing to lose", () => {
    expect(warns(bash("git reset --hard"))).toBe(false);
  });

  it("warns before overwriting a credentials file", () => {
    const env = path.join(repo, ".env");
    fs.writeFileSync(env, "SECRET=1\n");
    const out = run({ tool_name: "Write", tool_input: { file_path: env } });
    expect(warns(out)).toBe(true);
    expect(out.stdout).toContain("passwords or keys");
  });

  it("warns on a bulk rm naming more than five paths", () => {
    for (const n of ["a", "b", "c", "d", "e", "f", "g"]) {
      fs.writeFileSync(path.join(repo, `${n}.txt`), "keep\n");
    }
    const out = bash("rm a.txt b.txt c.txt d.txt e.txt f.txt g.txt");
    expect(warns(out)).toBe(true);
  });

  it("stays silent when the paths don't exist, since nothing is actually lost", () => {
    expect(warns(bash("rm gone1.txt gone2.txt gone3.txt gone4.txt gone5.txt gone6.txt"))).toBe(
      false,
    );
  });
});

describe("only says a delete can be undone when git has actually confirmed it", () => {
  let outside: string;
  beforeEach(() => {
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-dw-nogit-"));
    fs.mkdirSync(path.join(outside, "stuff"));
    for (const n of ["a", "b", "c"]) fs.writeFileSync(path.join(outside, "stuff", n), "x\n");
  });
  afterEach(() => fs.rmSync(outside, { recursive: true, force: true }));

  it("says files outside any git repo can't be got back", () => {
    const out = bash("rm -rf stuff", outside);
    expect(warns(out)).toBe(true);
    expect(reasonOf(out)).toContain("3 files");
    expect(reasonOf(out)).toContain("aren't saved in git");
    expect(reasonOf(out)).not.toContain("could get it back");
  });

  it("says it couldn't check when git doesn't answer in time", () => {
    // A git that hangs: the old 0.1s budget turned this into "all saved".
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-dw-bin-"));
    fs.writeFileSync(path.join(fakeBin, "git"), "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
    try {
      const env = { ...process.env, PATH: `${fakeBin}:${process.env["PATH"]}` };
      const out = bash("rm -rf src/", repo, env);
      expect(warns(out)).toBe(true);
      expect(reasonOf(out)).toContain("couldn't confirm");
      expect(reasonOf(out)).not.toContain("could get it back");
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  }, 30_000);

  it("speaks up about git reset --hard when git can't say whether anything is unsaved", () => {
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "ccpanel-dw-bin-"));
    fs.writeFileSync(path.join(fakeBin, "git"), "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
    try {
      const env = { ...process.env, PATH: `${fakeBin}:${process.env["PATH"]}` };
      expect(warns(bash("git reset --hard", repo, env))).toBe(true);
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("reads paths the way the shell would", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    // Not under the system temp dir: the hook rightly ignores deletes in
    // /tmp, which would hide whether ~ was read at all. Its own git repo, so
    // the answer about unsaved work doesn't depend on this checkout.
    home = fs.mkdtempSync(path.join(projectRoot, "test", ".tmp-home-"));
    execSync("git init -q .", { cwd: home });
    fs.mkdirSync(path.join(home, "stuff"));
    for (const n of ["a", "b"]) fs.writeFileSync(path.join(home, "stuff", n), "x\n");
    env = { ...process.env, HOME: home };
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  for (const cmd of [
    "rm -rf ~/stuff",
    "rm -rf $HOME/stuff",
    "rm -rf ${HOME}/stuff",
    'rm -rf "$HOME/stuff"',
    "cd /tmp && rm -rf ~/stuff",
  ]) {
    it(`warns on: ${cmd}`, () => {
      const out = bash(cmd, repo, env);
      expect(warns(out)).toBe(true);
      expect(reasonOf(out)).toContain("2 files");
      expect(reasonOf(out)).toContain("aren't saved in git");
    });
  }

  it("treats a quoted name with a space as one folder", () => {
    fs.mkdirSync(path.join(repo, "my photos"));
    for (const n of ["1.jpg", "2.jpg"]) fs.writeFileSync(path.join(repo, "my photos", n), "x");
    execSync("git add -A && git commit -qm photos", { cwd: repo });
    for (const cmd of ['rm -rf "my photos"', "rm -rf 'my photos'", "rm -rf my\\ photos"]) {
      const out = bash(cmd);
      expect(warns(out), cmd).toBe(true);
      expect(reasonOf(out), cmd).toContain("2 files");
    }
  });

  it("asks when a recursive delete names something only known at run time", () => {
    const out = bash('rm -rf "$BUILD_ROOT/output"');
    expect(warns(out)).toBe(true);
    expect(reasonOf(out)).toContain("only filled in when the command runs");
    expect(warns(bash("rm -rf $(pwd)/src"))).toBe(true);
  });

  it('still treats rm -rf "$HOME" as the whole home folder', () => {
    expect(reasonOf(bash('rm -rf "$HOME"', repo, env))).toContain("whole home folder");
    expect(reasonOf(bash("rm -rf ~/", repo, env))).toContain("whole home folder");
  });

  it("isn't fooled by a redirection or an unrelated command", () => {
    expect(warns(bash("rm -rf node_modules 2>/dev/null"))).toBe(false);
    expect(warns(bash("echo rm -rf src > notes.txt"))).toBe(false);
  });
});

describe("the message is alarming and plain (§9.5)", () => {
  it("rings the terminal and raises a desktop notification for severe cases", () => {
    const out = bash("rm -rf /");
    expect(out.stdout).toContain("terminalSequence");
    expect(out.stdout).toContain("777;notify");
    expect(out.stdout).toContain("\\u0007"); // BEL
  });

  it("also surfaces the warning as a visible system message", () => {
    expect(bash("rm -rf /").stdout).toContain('"systemMessage"');
  });

  it("uses ask, never deny — the user stays in charge", () => {
    const out = bash("rm -rf /");
    expect(out.stdout).toContain('"ask"');
    expect(out.stdout).not.toContain('"deny"');
  });

  it("never leaks a rule name, pattern or jargon into the words the user reads", () => {
    for (const cmd of ["rm -rf /", "terraform destroy", "git reset --hard"]) {
      fs.appendFileSync(path.join(repo, "src", "file1.ts"), "// e\n");
      const out = bash(cmd);
      // Only the human-readable text — the JSON envelope necessarily carries
      // protocol names like hookEventName, which the user never sees.
      const reason = (
        /"permissionDecisionReason":"((?:[^"\\]|\\.)*)"/.exec(out.stdout)?.[1] ?? ""
      ).toLowerCase();
      expect(reason.length).toBeGreaterThan(0);
      for (const jargon of [
        "regex",
        "pattern",
        "pretooluse",
        "hook",
        "matcher",
        "json",
        "exit code",
      ]) {
        expect(reason).not.toContain(jargon);
      }
    }
  });

  it("keeps the message to two lines", () => {
    const out = bash("rm -rf /");
    const reason = /"permissionDecisionReason":"((?:[^"\\]|\\.)*)"/.exec(out.stdout)?.[1] ?? "";
    expect(reason.split("\\n").length).toBeLessThanOrEqual(2);
  });
});

describe("acceptance #14: fails open on bad input, always", () => {
  const badInputs: Array<[string, string]> = [
    ["malformed JSON", "{ not json ,,,,"],
    ["empty stdin", ""],
    ["whitespace only", "   \n  "],
    ["valid JSON, wrong shape", '{"hello":"world"}'],
    ["null", "null"],
    ["array", "[1,2,3]"],
    ["missing tool_input", '{"tool_name":"Bash"}'],
    ["binary junk", " garbage"],
  ];

  for (const [name, payload] of badInputs) {
    it(`exits 0 and allows the call: ${name}`, () => {
      const out = run(payload);
      expect(out.code).toBe(0);
      expect(warns(out)).toBe(false);
    });
  }

  it("handles a 10MB payload without hanging", () => {
    const huge = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: `rm -rf ${"a".repeat(10_000_000)}` },
    });
    const started = Date.now();
    const out = run(huge);
    expect(out.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("acceptance #17: speed", () => {
  it("stays under 200ms on a repository with 10,000 files", () => {
    const big = path.join(repo, "big");
    for (let d = 0; d < 100; d++) {
      const dir = path.join(big, `d${d}`);
      fs.mkdirSync(dir, { recursive: true });
      for (let f = 0; f < 100; f++) fs.writeFileSync(path.join(dir, `f${f}.txt`), "x\n");
    }
    execSync("git add -A && git commit -qm big", { cwd: repo });

    // Warm the filesystem cache, then measure.
    bash("rm -rf big/");
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      bash("rm -rf big/");
      runs.push(Date.now() - t0);
    }

    expect(Math.min(...runs)).toBeLessThan(200);
  }, 120_000);
});

describe("files git ignores are never called saved", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(repo, "config"), { recursive: true });
    fs.writeFileSync(path.join(repo, "config", "app.json"), "{}\n");
    fs.appendFileSync(path.join(repo, ".gitignore"), "secrets.env\n");
    execSync("git add -A && git commit -qm config", { cwd: repo });
  });

  it("warns that an ignored secrets file inside a clean folder has no copy", () => {
    fs.writeFileSync(path.join(repo, "config", "secrets.env"), "TOKEN=x\n");

    const out = bash("rm -rf config");

    expect(warns(out)).toBe(true);
    expect(reasonOf(out)).toContain("Git ignores 1 item in it (like secrets.env)");
    expect(reasonOf(out)).not.toContain("you could get it back");
  });

  it("still reassures when the folder holds only tracked, committed files", () => {
    const out = bash("rm -rf config");
    expect(reasonOf(out)).toContain("All of it is saved in git, so you could get it back.");
  });

  it("says build output is the exception rather than calling it saved", () => {
    fs.mkdirSync(path.join(repo, "config", "node_modules", "x"), { recursive: true });
    fs.writeFileSync(path.join(repo, "config", "node_modules", "x", "i.js"), "1\n");

    const out = bash("rm -rf config");

    expect(reasonOf(out)).toContain("Apart from build output that can be rebuilt");
  });
});
