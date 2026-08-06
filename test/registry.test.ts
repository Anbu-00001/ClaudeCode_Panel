import { describe, expect, it } from "vitest";
import { CURATED, CURATED_BY_FULL_NAME, describeStars, withStars } from "../src/core/registry.js";

/**
 * Pure ranking behaviour only — no network. The live registry and GitHub are
 * exercised by hand; tests must not depend on either being reachable or on a
 * rate limit that is shared per IP address.
 */

function makeResult(over: Partial<Parameters<typeof withStars>[0]> = {}) {
  return {
    name: "io.github.someone/thing",
    description: "does a thing",
    repositoryUrl: "https://github.com/someone/thing",
    version: "1.0.0",
    updatedAt: new Date(),
    isLatest: true,
    isActive: true,
    curated: false,
    stars: null,
    score: 0,
    ...over,
  };
}

describe("curated list is exact-match only", () => {
  it("does not vouch for a lookalike just because the name contains a curated word", () => {
    // The bug this guards: `playwright-stealth` and `playwrightselectorguard`
    // were being marked hand-checked and given the official server's wording.
    for (const lookalike of ["playwright-stealth", "playwrightselectorguard-mcp", "playwright-report-mcp"]) {
      expect(Object.keys(CURATED)).not.toContain(lookalike);
      expect(lookalike in CURATED).toBe(false);
    }
  });

  it("knows the official Playwright server by its full registry name", () => {
    expect(CURATED_BY_FULL_NAME["io.github.microsoft/playwright-mcp"]).toBeTruthy();
  });

  it("describes every curated tool in words a beginner understands", () => {
    for (const [name, description] of Object.entries(CURATED)) {
      expect(description.length, name).toBeGreaterThan(10);
      for (const jargon of ["MCP", "server", "protocol", "stdio", "API"]) {
        expect(description.includes(jargon), `"${name}" says "${jargon}"`).toBe(false);
      }
    }
  });
});

describe("ranking", () => {
  it("puts a hand-checked tool above an unchecked one", () => {
    const curated = withStars(makeResult({ curated: true }), null, "thing");
    const plain = withStars(makeResult({ curated: false }), null, "thing");
    expect(curated.score).toBeGreaterThan(plain.score);
  });

  it("lets stars raise a result, but not past a hand-checked one", () => {
    const popular = withStars(makeResult({ curated: false }), 50_000, "thing");
    const curated = withStars(makeResult({ curated: true }), null, "thing");
    const unpopular = withStars(makeResult({ curated: false }), 3, "thing");

    expect(popular.score).toBeGreaterThan(unpopular.score);
    expect(curated.score).toBeGreaterThan(popular.score);
  });

  it("ranks an exact name match above a partial one", () => {
    const exact = withStars(makeResult({ name: "x/postgres" }), null, "postgres");
    const partial = withStars(makeResult({ name: "x/postgres-extras" }), null, "postgres");
    expect(exact.score).toBeGreaterThan(partial.score);
  });

  it("penalises something not touched in years", () => {
    const fresh = withStars(makeResult({ updatedAt: new Date() }), null, "thing");
    const stale = withStars(
      makeResult({ updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 365 * 3) }),
      null,
      "thing",
    );
    expect(fresh.score).toBeGreaterThan(stale.score);
  });

  it("prefers a tool that publishes its source", () => {
    const open = withStars(makeResult({ repositoryUrl: "https://github.com/a/b" }), null, "thing");
    const opaque = withStars(makeResult({ repositoryUrl: null }), null, "thing");
    expect(open.score).toBeGreaterThan(opaque.score);
  });
});

describe("unknown popularity is never shown as zero", () => {
  it("says it isn't known when the count is unavailable", () => {
    // GitHub allows 60 unauthenticated requests an hour, shared per IP, so
    // this is a normal outcome rather than an error.
    expect(describeStars(null)).toBe("how popular it is isn't known");
    expect(describeStars(null)).not.toContain("0");
  });

  it("reads naturally at every magnitude", () => {
    expect(describeStars(1)).toBe("1 person starred it");
    expect(describeStars(42)).toBe("42 people starred it");
    expect(describeStars(15_600)).toBe("15.6k people starred it");
  });
});
