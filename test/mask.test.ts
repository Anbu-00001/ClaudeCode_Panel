import { describe, expect, it } from "vitest";
import {
  isSecret,
  looksLikeSecret,
  MASK,
  maskDeep,
  maskText,
  maskValue,
} from "../src/core/mask.js";

describe("secret detection (§12.4)", () => {
  it("recognises credential shapes by value", () => {
    expect(looksLikeSecret("sk-ant-abc123")).toBe(true);
    expect(looksLikeSecret("sk-proj-9fj20fj20f")).toBe(true);
    expect(looksLikeSecret("ghp_16C7e42F292c6912E7710c838347Ae178B4a")).toBe(true);
    expect(looksLikeSecret("github_pat_11ABCDEFG0abcdefghijkl_MNOPQ")).toBe(true);
    expect(looksLikeSecret("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc")).toBe(true);
    expect(looksLikeSecret("a".repeat(48))).toBe(true);
  });

  it("leaves ordinary config values alone", () => {
    expect(looksLikeSecret("npx")).toBe(false);
    expect(looksLikeSecret("postgres")).toBe(false);
    expect(looksLikeSecret("Bash(git diff *)")).toBe(false);
    expect(looksLikeSecret("")).toBe(false);
  });

  it("treats a suggestive key name as secret whatever the value looks like", () => {
    expect(isSecret("hunter2", "password")).toBe(true);
    expect(isSecret("abc", "GITHUB_TOKEN")).toBe(true);
    expect(isSecret("abc", "apiKey")).toBe(true);
    expect(isSecret("abc", "AUTH_HEADER")).toBe(true);
    expect(isSecret("abc", "command")).toBe(false);
  });

  it("masks a whole subtree under a secret-looking key", () => {
    const masked = maskDeep({ auth: { token: "abc", nested: { deeper: "xyz" } } }) as Record<
      string,
      unknown
    >;
    expect(masked["auth"]).toBe(MASK);
  });

  it("preserves structure and non-secret values while masking secrets", () => {
    const masked = maskDeep({
      mcpServers: {
        db: {
          command: "npx",
          args: ["-y", "server-postgres"],
          env: { DATABASE_URL: "postgres://localhost/x", API_KEY: "sk-ant-abc123" },
        },
      },
    }) as any;

    expect(masked.mcpServers.db.command).toBe("npx");
    expect(masked.mcpServers.db.args).toEqual(["-y", "server-postgres"]);
    expect(masked.mcpServers.db.env.API_KEY).toBe(MASK);
  });

  it("masks credential-shaped substrings inside free text", () => {
    const text = 'error near "apiKey": "sk-ant-abc123def456" at line 4';
    const out = maskText(text);
    expect(out).not.toContain("sk-ant-abc123def456");
    expect(out).toContain(MASK);
    expect(out).toContain("at line 4");
  });

  it("masks single values on request", () => {
    expect(maskValue("sk-ant-abc123")).toBe(MASK);
    expect(maskValue("plain")).toBe("plain");
    expect(maskValue("plain", "token")).toBe(MASK);
  });

  it("handles null and non-objects without throwing", () => {
    expect(maskDeep(null)).toBeNull();
    expect(maskDeep(42)).toBe(42);
    expect(maskDeep(undefined)).toBeUndefined();
  });
});

describe("secrets that hide inside ordinary-looking values", () => {
  it("masks a token in a URL's query string but keeps the rest readable", () => {
    const out = maskText("https://api.example.com/v1?project=demo&token=abc123secret&x=1");
    expect(out).not.toContain("abc123secret");
    expect(out).toContain("project=demo");
    expect(out).toContain("x=1");
    expect(maskText("https://x.test/cb?api_key=zzz999")).not.toContain("zzz999");
  });

  it("masks the password in a URL, and a bare token used as the user name", () => {
    const withPassword = maskText("postgres://admin:hunter2@db.local:5432/app");
    expect(withPassword).not.toContain("hunter2");
    expect(withPassword).toContain("admin");
    const token = "f00dfeed".repeat(5);
    expect(maskText(`https://${token}@github.com/x.git`)).not.toContain(token);
    expect(maskText("ssh://git@github.com/x.git")).toBe("ssh://git@github.com/x.git");
  });

  it("masks the value after a secret flag, in text and in an argv array", () => {
    for (const line of [
      "server --api-key abc123 --port 80",
      "server --token=abc123",
      'server --secret "abc123"',
      "server --password abc123",
    ]) {
      const out = maskText(line);
      expect(out, line).not.toContain("abc123");
    }
    expect(maskText("server --port 80")).toBe("server --port 80");

    const args = maskDeep(["-y", "server", "--api-key", "abc123", "--port", "80"]);
    expect(args).toEqual(["-y", "server", "--api-key", MASK, "--port", "80"]);
  });

  it("recognises AWS, npm and Google keys", () => {
    const aws = "AKIAIOSFODNN7EXAMPLE";
    const npm = `npm_${"a1B2".repeat(9)}`;
    const google = `AIza${"Sy0_-abcdefghij".padEnd(35, "k")}`;
    expect(google).toHaveLength(39);
    for (const value of [aws, npm, google]) {
      expect(looksLikeSecret(value), value).toBe(true);
      expect(maskText(`found ${value} here`), value).toBe(`found ${MASK} here`);
    }
  });

  it("masks a secret-bearing URL inside a config without hiding the whole thing", () => {
    const masked = maskDeep({ env: { DATABASE_URL: "postgres://u:pw123@h/db" } }) as {
      env: Record<string, string>;
    };
    expect(masked.env["DATABASE_URL"]).toBe(`postgres://u:${MASK}@h/db`);
  });
});

describe("more credential shapes", () => {
  it("recognises Stripe and GitLab keys, alone and inside text", () => {
    for (const v of [
      "sk_test_EXAMPLEnotARealKey000000",
      "rk_live_EXAMPLEnotARealKey00",
      "glpat-xxxxxxxxxxxxxxxxxxxx",
    ]) {
      expect(looksLikeSecret(v), v).toBe(true);
      expect(maskText(`use ${v} here`)).toBe(`use ${MASK} here`);
    }
  });

  it("masks a bearer token but keeps the header readable", () => {
    expect(maskText("curl -H 'Authorization: Bearer abc.def-123' https://x")).toBe(
      `curl -H 'Authorization: Bearer ${MASK}' https://x`,
    );
  });

  it("masks a secret-named variable set inline", () => {
    expect(maskText("DB_PASSWORD=hunter2 MY_PWD=x API_KEY='a b' GH_TOKEN=t npm start")).toBe(
      `DB_PASSWORD=${MASK} MY_PWD=${MASK} API_KEY=${MASK} GH_TOKEN=${MASK} npm start`,
    );
    expect(maskText("NODE_ENV=production PORT=3000")).toBe("NODE_ENV=production PORT=3000");
  });

  it("never breaks the JSON of a line it masks", () => {
    const line = JSON.stringify({ command: 'SECRET="a\\"b" run', h: "Bearer x\\y" });
    expect(() => JSON.parse(maskText(line))).not.toThrow();
  });

  it("treats keys named pass, pwd or bearer as secret", () => {
    expect(maskDeep({ db_pass: "x", pwd: "y", bearer: "z", name: "n" })).toEqual({
      db_pass: MASK,
      pwd: MASK,
      bearer: MASK,
      name: "n",
    });
  });
});
