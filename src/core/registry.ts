import { z } from "zod";

/**
 * Finding tools to add (§10.4).
 *
 * Ranking, and why it works this way. The official MCP registry was queried
 * directly while building this: an entry carries `name`, `description`,
 * `repository.url` and publication timestamps, and NOTHING about popularity —
 * no stars, no downloads, no install counts. So "sort by stars" cannot be
 * answered by the registry alone.
 *
 * The approach, cheapest signal first:
 *
 *   1. CURATED. A hand-checked list always sorts above everything else. This
 *      is the only signal that actually means "worth using", because a person
 *      decided so. Costs nothing and works offline.
 *   2. STRUCTURAL. Free signals already in the registry response: is this the
 *      latest version, is it active, does it publish a source repository, how
 *      recently was it updated, and does the text actually match what was
 *      typed.
 *   3. STARS, ON DEMAND ONLY. Fetched for the one entry under the cursor, then
 *      cached. Never for a whole result page — GitHub allows 60 unauthenticated
 *      requests an hour, so ranking 20 results by stars would exhaust the quota
 *      in three searches and then silently return nothing.
 *
 * Network use is bounded and never speculative: the registry when the user
 * searches, and one GitHub request when the user rests on a result.
 */

const REGISTRY_BASE = "https://registry.modelcontextprotocol.io/v0/servers";
const GITHUB_REPO_API = "https://api.github.com/repos";
const TIMEOUT_MS = 6000;

const registryServerSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  title: z.string().optional(),
  version: z.string().optional(),
  repository: z.looseObject({ url: z.string().optional(), source: z.string().optional() }).optional(),
  websiteUrl: z.string().optional(),
  packages: z.array(z.unknown()).optional(),
  remotes: z.array(z.unknown()).optional(),
});

const registryResponseSchema = z.looseObject({
  servers: z.array(
    z.looseObject({
      server: registryServerSchema,
      _meta: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  metadata: z.looseObject({ nextCursor: z.string().optional(), count: z.number().optional() }).optional(),
});

export interface ToolResult {
  name: string;
  /** Curated plain-English line if we have one, else the publisher's own. */
  description: string;
  repositoryUrl: string | null;
  version: string | null;
  updatedAt: Date | null;
  isLatest: boolean;
  isActive: boolean;
  curated: boolean;
  /** Filled in only once the user rests on this row. */
  stars: number | null;
  score: number;
}

/**
 * Hand-checked servers. Being on this list is the strongest quality signal we
 * have, so these always sort first. Descriptions are written for someone who
 * has never heard of MCP (§16).
 */
export const CURATED_BY_FULL_NAME: Record<string, string> = {
  "io.github.microsoft/playwright-mcp": "Lets Claude click through your site in a real browser",
};

export const CURATED: Record<string, string> = {
  playwright: "Lets Claude click through your site in a real browser",
  filesystem: "Lets Claude read and write files in a folder you choose",
  github: "Lets Claude read your issues and pull requests",
  postgres: "Lets Claude query your database",
  sqlite: "Lets Claude query a database file on your computer",
  puppeteer: "Lets Claude control a browser to check your site",
  slack: "Lets Claude read and post messages in Slack",
  sentry: "Lets Claude look up errors your app has hit",
  memory: "Gives Claude notes it can keep between conversations",
  fetch: "Lets Claude read a web page you point it at",
  git: "Lets Claude look through your project's history",
  notion: "Lets Claude read and update your Notion pages",
  linear: "Lets Claude read and update your Linear issues",
  figma: "Lets Claude read your designs",
  stripe: "Lets Claude look up payments and customers",
};

/**
 * Exact matches only.
 *
 * A substring match here is actively harmful and was caught doing real damage:
 * matching "playwright" inside `playwright-stealth`, `playwright-report-mcp`
 * and `playwrightselectorguard-mcp` marked three unrelated third-party servers
 * as hand-checked, gave them Microsoft's description, and floated them level
 * with the official one. Vouching for something nobody vetted is the opposite
 * of what this list is for.
 */
function curatedDescriptionFor(name: string): string | null {
  if (name in CURATED_BY_FULL_NAME) return CURATED_BY_FULL_NAME[name] as string;
  const tail = name.includes("/") ? (name.split("/").pop() as string) : name;
  if (tail in CURATED) return CURATED[tail] as string;
  return null;
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  signal?.addEventListener("abort", () => controller.abort());
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "ccpanel" },
    });
    if (!res.ok) throw new Error(`The tool directory answered with ${res.status}.`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function metaOf(entry: { _meta?: Record<string, unknown> }): Record<string, unknown> {
  const meta = entry._meta ?? {};
  const official = meta["io.modelcontextprotocol.registry/official"];
  return typeof official === "object" && official !== null ? (official as Record<string, unknown>) : {};
}

function scoreOf(result: Omit<ToolResult, "score">, query: string): number {
  let score = 0;
  if (result.curated) score += 1000; // a person vouched for it
  if (result.isLatest) score += 40;
  if (result.isActive) score += 40;
  if (result.repositoryUrl) score += 20; // you can go read the source

  const q = query.trim().toLowerCase();
  if (q.length > 0) {
    const tail = (result.name.split("/").pop() ?? result.name).toLowerCase();
    if (tail === q) score += 120;
    else if (tail.startsWith(q)) score += 60;
    else if (tail.includes(q)) score += 30;
    if (result.description.toLowerCase().includes(q)) score += 10;
  }

  if (result.updatedAt) {
    const months = (Date.now() - result.updatedAt.getTime()) / (1000 * 60 * 60 * 24 * 30);
    if (months < 3) score += 25;
    else if (months < 12) score += 10;
    else if (months > 24) score -= 15; // looks abandoned
  }

  if (result.stars !== null) score += Math.min(60, Math.round(Math.log10(result.stars + 1) * 20));
  return score;
}

export interface SearchOutcome {
  ok: boolean;
  results: ToolResult[];
  /** Plain-language reason, shown instead of a fake empty list. */
  message: string | null;
}

/** Searches the registry. One network call, and it degrades to a message. */
export async function searchTools(query: string, signal?: AbortSignal): Promise<SearchOutcome> {
  const url = `${REGISTRY_BASE}?search=${encodeURIComponent(query)}&limit=30`;

  let raw: unknown;
  try {
    raw = await fetchJson(url, signal);
  } catch (err) {
    return {
      ok: false,
      results: [],
      message:
        (err as Error).name === "AbortError"
          ? "That search took too long. Check your connection and try again."
          : "Can't reach the list of tools right now. Everything else still works.",
    };
  }

  const parsed = registryResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, results: [], message: "The list of tools came back in a form we didn't expect." };
  }

  // The registry returns one row per published version; keep the newest of each.
  const byName = new Map<string, ToolResult>();
  for (const entry of parsed.data.servers) {
    const meta = metaOf(entry);
    const server = entry.server;
    const curatedDescription = curatedDescriptionFor(server.name);
    const updatedRaw = meta["updatedAt"];

    const candidate: Omit<ToolResult, "score"> = {
      name: server.name,
      description: curatedDescription ?? server.description ?? "",
      repositoryUrl: server.repository?.url ?? null,
      version: server.version ?? null,
      updatedAt: typeof updatedRaw === "string" ? new Date(updatedRaw) : null,
      isLatest: meta["isLatest"] === true,
      isActive: meta["status"] === "active",
      curated: curatedDescription !== null,
      stars: null,
    };

    const existing = byName.get(server.name);
    if (!existing || (candidate.isLatest && !existing.isLatest)) {
      byName.set(server.name, { ...candidate, score: scoreOf(candidate, query) });
    }
  }

  const results = [...byName.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return {
    ok: true,
    results,
    message: results.length === 0 ? "Nothing matched that. Try a different word." : null,
  };
}

const starCache = new Map<string, number | null>();

function parseGitHubRepo(url: string): { owner: string; repo: string } | null {
  const match = /github\.com\/([^/]+)\/([^/#?]+)/.exec(url);
  if (!match?.[1] || !match[2]) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
}

/**
 * Stars for ONE entry — the row the user is resting on. Cached for the session
 * so arrowing up and down a list re-requests nothing.
 *
 * Returns null when unknown (not on GitHub, offline, or rate-limited). A null
 * is displayed as "not known", never as zero: showing 0 stars for a popular
 * project because a quota ran out would be worse than showing nothing.
 */
export async function fetchStars(repositoryUrl: string | null, signal?: AbortSignal): Promise<number | null> {
  if (!repositoryUrl) return null;
  if (starCache.has(repositoryUrl)) return starCache.get(repositoryUrl) ?? null;

  const parsed = parseGitHubRepo(repositoryUrl);
  if (!parsed) {
    starCache.set(repositoryUrl, null);
    return null;
  }

  try {
    const data = await fetchJson(`${GITHUB_REPO_API}/${parsed.owner}/${parsed.repo}`, signal);
    const count = (data as { stargazers_count?: unknown }).stargazers_count;
    const stars = typeof count === "number" ? count : null;
    starCache.set(repositoryUrl, stars);
    return stars;
  } catch {
    starCache.set(repositoryUrl, null); // rate limit or offline: stay quiet
    return null;
  }
}

/** Re-scores a row once its stars are known. */
export function withStars(result: ToolResult, stars: number | null, query: string): ToolResult {
  const updated = { ...result, stars };
  return { ...updated, score: scoreOf(updated, query) };
}

export function describeStars(stars: number | null): string {
  if (stars === null) return "how popular it is isn't known";
  if (stars >= 1000) return `${(stars / 1000).toFixed(1)}k people starred it`;
  return `${stars} ${stars === 1 ? "person" : "people"} starred it`;
}

export function _resetStarCacheForTests(): void {
  starCache.clear();
}
