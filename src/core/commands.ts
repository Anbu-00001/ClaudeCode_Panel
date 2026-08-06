import { createRequire } from "node:module";

/**
 * The command library (§11.2). Loaded from src/data/commands.json, which is
 * built only from the official commands page — community lists circulate
 * commands that do not exist, and teaching a beginner to type nonsense is
 * worse than omitting something.
 */

export interface CommandEntry {
  name: string;
  args: string | null;
  category: string;
  plain: string;
  why: string | null;
  costsTokens: boolean;
  isSkill: boolean;
  removed: boolean;
  needsWording: boolean;
  official: string;
}

export interface CommandLibrary {
  generated: string;
  sourceUrl: string;
  categories: string[];
  commands: CommandEntry[];
}

const require = createRequire(import.meta.url);

export function loadCommands(): CommandLibrary {
  return require("../data/commands.json") as CommandLibrary;
}

/** Days since the list was last checked against the docs (§11.3). */
export function daysSinceGenerated(library: CommandLibrary, now: Date = new Date()): number {
  const then = new Date(library.generated);
  if (Number.isNaN(then.getTime())) return 0;
  return Math.floor((now.getTime() - then.getTime()) / 86_400_000);
}

export function isStale(library: CommandLibrary, now: Date = new Date()): boolean {
  return daysSinceGenerated(library, now) > 60;
}

/**
 * Ranks matches so the useful one is first: an exact name beats a name prefix,
 * which beats a word in the plain description, which beats the situation text.
 */
export function searchCommands(library: CommandLibrary, query: string): CommandEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return library.commands.filter((c) => !c.removed);

  const scored: Array<{ entry: CommandEntry; score: number }> = [];
  for (const entry of library.commands) {
    const name = entry.name.toLowerCase();
    const bare = name.replace(/^\//, "");
    let score = 0;

    if (name === q || bare === q) score = 100;
    else if (bare.startsWith(q.replace(/^\//, ""))) score = 80;
    else if (name.includes(q)) score = 60;
    else if (entry.plain.toLowerCase().includes(q)) score = 40;
    else if ((entry.why ?? "").toLowerCase().includes(q)) score = 30;
    else if (entry.category.toLowerCase().includes(q)) score = 20;
    else if (entry.official.toLowerCase().includes(q)) score = 10;

    if (score === 0) continue;
    if (entry.removed) score -= 50; // still findable, never promoted
    scored.push({ entry, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .map((s) => s.entry);
}

export function groupByCategory(library: CommandLibrary): Array<{ category: string; commands: CommandEntry[] }> {
  return library.categories
    .map((category) => ({
      category,
      commands: library.commands.filter((c) => c.category === category),
    }))
    .filter((g) => g.commands.length > 0);
}
