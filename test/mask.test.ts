import { describe, expect, it } from "vitest";
import { MASK, isSecret, looksLikeSecret, maskDeep, maskText, maskValue } from "../src/core/mask.js";

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
    const masked = maskDeep({ auth: { token: "abc", nested: { deeper: "xyz" } } }) as Record<string, unknown>;
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
