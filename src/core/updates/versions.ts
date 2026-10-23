/** Parsing and comparing version strings. Part of core/updates.ts — see the overview there. */

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** 1 to 4 numeric parts. Anything else is not a version we can reason about. */
export const CORE_PATTERN = /^\d+(?:\.\d+){0,3}$/;
/** A version-looking run inside arbitrary output: `sometool 1.2.3`, `v2.0.0-rc.1`. */
export const VERSION_IN_TEXT =
  /(?:^|[^\w.-])v?(\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)(?![\w.-])/;

export interface ParsedVersion {
  core: number[];
  prerelease: string[];
}

export function parseVersionParts(raw: string): ParsedVersion | null {
  let text = raw.trim();
  if (text === "") return null;
  text = text.replace(/^[vV]/, "");

  // Build metadata (`1.0.0+build.7`) is explicitly ignored when comparing.
  const plus = text.indexOf("+");
  if (plus !== -1) text = text.slice(0, plus);

  const dash = text.indexOf("-");
  const core = dash === -1 ? text : text.slice(0, dash);
  const pre = dash === -1 ? "" : text.slice(dash + 1);
  if (!CORE_PATTERN.test(core)) return null;
  if (dash !== -1 && pre.trim() === "") return null; // `1.0.0-` is junk, not a release

  const numbers = core.split(".").map((part) => Number(part));
  if (numbers.some((n) => !Number.isSafeInteger(n))) return null;

  const identifiers = pre === "" ? [] : pre.split(".");
  if (identifiers.some((id) => id === "")) return null;

  return { core: numbers, prerelease: identifiers };
}

/** True when this string is something we can actually order against another. */
export function isComparableVersion(raw: string): boolean {
  return parseVersionParts(raw) !== null;
}

export function comparePrerelease(a: string[], b: string[]): -1 | 0 | 1 {
  // A release outranks any prerelease of the same numbers: 1.0.0 > 1.0.0-rc.1.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) return -1; // fewer identifiers sorts first
    if (right === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      const l = Number(left);
      const r = Number(right);
      if (l !== r) return l < r ? -1 : 1;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1; // numbers rank below words
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Orders two versions the way semver does, without taking on a dependency for
 * it. Returns null when either side isn't a version at all — a branch name, a
 * commit hash, "latest" — which becomes an UNKNOWN status rather than a guess.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const left = parseVersionParts(a);
  const right = parseVersionParts(b);
  if (!left || !right) return null;

  const length = Math.max(left.core.length, right.core.length);
  for (let i = 0; i < length; i++) {
    // Missing trailing parts are zero, so 1.0 and 1.0.0 are the same release.
    const l = left.core[i] ?? 0;
    const r = right.core[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/**
 * Pulls a version out of whatever a command prints for `--version`, which is
 * anything from `1.2.3` to `mytool version 1.2.3 (build abc)`.
 */
export function extractVersion(text: string): string | null {
  const lines = text.split("\n").slice(0, 10);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (parseVersionParts(trimmed)) return trimmed.replace(/^[vV]/, "");
    const match = VERSION_IN_TEXT.exec(trimmed);
    if (match?.[1]) return match[1];
  }
  return null;
}
