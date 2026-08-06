#!/usr/bin/env node
import { render } from "ink";
import React from "react";
import { App } from "./app.js";

function tooSmall(): boolean {
  const columns = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  return columns < 80 || rows < 24;
}

// Pre-flight check avoids paying for an Ink render (alt-screen, raw mode)
// when we already know the terminal can't fit the UI.
if (process.stdout.isTTY && tooSmall()) {
  process.stdout.write("ccpanel needs a window at least 80 columns wide.\n");
  process.exit(0);
}

const { waitUntilExit } = render(<App />);

waitUntilExit().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
