import { describe, expect, it } from "vitest";
import { ATTRIBUTION_LIMIT, PRIVACY_NOTE, formatMoney, friendlyModel, parseUsage } from "../src/core/ccusage.js";

/** Shapes captured from the real ccusage 20.0.19 output, not invented. */
const REAL_DAILY = {
  daily: [
    {
      period: "2026-08-05", totalCost: 12.5, totalTokens: 900,
      modelsUsed: ["claude-opus-5"],
      modelBreakdowns: [{ modelName: "claude-opus-5", cost: 12.5, inputTokens: 5 }],
    },
    {
      period: "2026-08-06", totalCost: 48.25078889999998, totalTokens: 1200,
      modelsUsed: ["claude-opus-5", "claude-sonnet-5"],
      modelBreakdowns: [
        { modelName: "claude-sonnet-5", cost: 8.0 },
        { modelName: "claude-opus-5", cost: 40.25078889999998 },
      ],
    },
  ],
  totals: { totalCost: 3081.7351968499993, totalTokens: 2100 },
};

describe("reading spending", () => {
  it("reads the real ccusage shape", () => {
    const r = parseUsage(REAL_DAILY, "daily");
    expect(r.rows).toHaveLength(2);
    expect(r.totalCost).toBeCloseTo(3081.735, 2);
    expect(r.rows[0]?.label).toBe("2026-08-06"); // newest first
    expect(r.rows[0]?.cost).toBeCloseTo(48.25, 2);
  });

  it("sorts each day's models by what they cost", () => {
    const r = parseUsage(REAL_DAILY, "daily");
    expect(r.rows[0]?.models[0]?.model).toBe("claude-opus-5");
  });

  it("finds the rows even when the key follows the subcommand name", () => {
    expect(parseUsage({ monthly: [{ month: "2026-08", totalCost: 5 }] }, "monthly").rows).toHaveLength(1);
    expect(parseUsage({ weekly: [{ period: "w1", totalCost: 5 }] }, "weekly").rows).toHaveLength(1);
  });

  it("returns nothing rather than throwing on junk", () => {
    for (const junk of [null, undefined, 42, "text", {}, { daily: "nope" }]) {
      expect(() => parseUsage(junk, "daily")).not.toThrow();
      expect(parseUsage(junk, "daily").rows).toEqual([]);
    }
  });

  it("falls back to summing rows when totals are missing", () => {
    const r = parseUsage({ daily: [{ period: "a", totalCost: 2 }, { period: "b", totalCost: 3 }] }, "daily");
    expect(r.totalCost).toBe(5);
  });

  it("names model families rather than showing raw ids", () => {
    expect(friendlyModel("claude-opus-5")).toBe("Opus");
    expect(friendlyModel("claude-sonnet-5")).toBe("Sonnet");
    expect(friendlyModel("claude-haiku-4-5-20251001")).toBe("Haiku");
    expect(friendlyModel("something-else")).toBe("something-else");
  });

  it("formats money readably", () => {
    expect(formatMoney(48.25078889999998)).toBe("$48.25");
    expect(formatMoney(3081.735)).toBe("$3.1k");
    expect(formatMoney(0)).toBe("$0.00");
  });

  it("refuses to imply per-tool costs exist (§10.7)", () => {
    expect(ATTRIBUTION_LIMIT).toContain("can't split it by individual tool");
    expect(PRIVACY_NOTE).toContain("Nothing was sent anywhere");
  });
});
