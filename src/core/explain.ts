import { createRequire } from "node:module";

/** The teaching content (§11.1) — one entry per capability, in plain English. */
export interface ExplainEntry {
  id: string;
  plainName: string;
  oneLine: string;
  whatItIs: string;
  whenYouWantIt: string;
  example: string;
  kitId: string | null;
  docsUrl: string;
}

const require = createRequire(import.meta.url);

export function loadExplain(): ExplainEntry[] {
  return (require("../data/explain.json") as { entries: ExplainEntry[] }).entries;
}
