import { render } from "ink-testing-library";
import { createRequire } from "node:module";
import React from "react";
import { describe, expect, it } from "vitest";
import { Banner, WORDMARK_LINES, accentColor, ccpanelVersion } from "../src/components/Banner.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

/**
 * The banner is decoration, so the thing worth testing is that it never costs
 * more than it gives: it must shrink and then disappear rather than push a
 * screen's own content out of an 80x24 window, which is the floor cli.tsx
 * enforces.
 */
describe("boot banner", () => {
  it("shows the wordmark when the window has rows to spare", () => {
    const { lastFrame } = render(<Banner columns={100} rows={40} />);
    const frame = lastFrame() ?? "";
    // Matched against the art itself rather than a copy of it, so editing the
    // letters can't leave this test asserting a wordmark nobody renders.
    for (const line of WORDMARK_LINES) {
      if (line.trim().length > 0) expect(frame).toContain(line.trim());
    }
  });

  it("falls back to one line when the window is too narrow for the art", () => {
    const { lastFrame } = render(<Banner columns={40} rows={40} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain(`ccpanel v${pkg.version}`);
    // The tall art must be gone, not wrapped.
    expect(frame.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(1);
  });

  it("renders nothing at all when there are no rows to spare", () => {
    // 80x24 is exactly the floor: every row belongs to the screen itself.
    const { lastFrame } = render(<Banner columns={80} rows={24} />);
    expect((lastFrame() ?? "").trim()).toBe("");
  });

  it("shows the real version, not a copy of it", () => {
    expect(ccpanelVersion()).toBe(pkg.version);
    const { lastFrame } = render(<Banner columns={100} rows={40} />);
    expect(lastFrame()).toContain(`v${pkg.version}`);
  });

  it("drops colour when NO_COLOR is set, whatever its value", () => {
    // https://no-color.org — presence is the signal, not the contents.
    expect(accentColor({ NO_COLOR: "1" })).toBeUndefined();
    expect(accentColor({ NO_COLOR: "0" })).toBeUndefined();
    expect(accentColor({ NO_COLOR: "" })).toBe("cyan");
    expect(accentColor({})).toBe("cyan");
  });
});
