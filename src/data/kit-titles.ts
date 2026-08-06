import type { RungId } from "../core/detect.js";

/**
 * Titles and rungs for the 11 kits listed in CCPANEL-SPEC.md §9.4, in the
 * spec's own hand-curated order. This is titles only, for the Ladder's
 * "Set up in one step" preview — no install logic. The real kit loader
 * (manifest, files, install/uninstall) is a later milestone; this file goes
 * away once kits/*.json exists and core/kits.ts reads it.
 */
export interface KitTitle {
  id: string;
  title: string;
  rung: RungId;
}

export const KIT_TITLES: KitTitle[] = [
  { id: "project-instructions", title: "Claude knows your project", rung: "instructions" },
  { id: "safe-permissions", title: "Claude stops asking permission for safe things", rung: "permissions" },
  { id: "code-reviewer", title: "Claude reviews your code before you commit", rung: "helpers" },
  { id: "commit-messages", title: "Claude writes your commit messages", rung: "commands" },
  { id: "remembers-conventions", title: "Claude remembers how you like things done", rung: "instructions" },
  { id: "browser-testing", title: "Claude tests your site in a real browser", rung: "tools" },
  { id: "database-reader", title: "Claude reads your database", rung: "tools" },
  { id: "explore-before-edit", title: "Claude explores before it edits", rung: "helpers" },
  { id: "self-check", title: "Claude checks its own work", rung: "automaticChecks" },
  { id: "memory-guard", title: "Claude keeps big jobs from eating your memory", rung: "memory" },
  { id: "deletion-warning", title: "Claude warns you before deleting anything big", rung: "automaticChecks" },
];
