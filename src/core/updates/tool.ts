import fs from "node:fs";
import path from "node:path";
import type { SkillInfo } from "../skills.js";
import type { ExecRunner } from "./exec.js";
import type { ManualUpdateCheck, ResolvedOptions, ToolUpdateCheck, UpdateStatus } from "./types.js";
import { describeAge, formatDay, makeCommand, statOrNull } from "./util.js";
import { compareVersions, extractVersion } from "./versions.js";

/** Checkers 3 and 4: a version marker next to a command, or nothing at all. Part of core/updates.ts — see the overview there. */

// ---------------------------------------------------------------------------
// 3. Tool — a version marker next to a command of the same name
// ---------------------------------------------------------------------------

/** Marker filenames that name no tool of their own — the directory names it. */
export const GENERIC_MARKERS = new Set(["version", "version.txt", ".version", "version.lock"]);
/** `.<tool>_version`, `<tool>-version`, `<tool>.version`, with an optional .txt. */
export const NAMED_MARKER = /^\.?([A-Za-z0-9][A-Za-z0-9.-]*?)[._-]version(?:\.txt)?$/i;

export interface VersionMarker {
  /** Absolute path to the marker file. */
  file: string;
  /** Contents, trimmed to a version if one can be read out of it. */
  version: string | null;
  /** Commands this marker could be talking about, best guess first. */
  candidates: string[];
}

/**
 * Looks for a file in the skill directory that records which version of some
 * tool the skill was installed for. This is what makes a hand-copied skill
 * checkable at all: the file names the command, the command reports its own
 * version, and the two can disagree.
 */
export function findVersionMarker(dir: string, skillName: string): VersionMarker | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  const dirName = path.basename(dir);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const lower = entry.name.toLowerCase();
    let candidates: string[] | null = null;

    if (GENERIC_MARKERS.has(lower) || lower === "version.md") {
      candidates = [dirName, skillName];
    } else {
      const named = NAMED_MARKER.exec(entry.name);
      if (named?.[1]) candidates = [named[1], dirName, skillName];
    }
    if (!candidates) continue;

    const file = path.join(dir, entry.name);
    let contents = "";
    try {
      contents = fs.readFileSync(file, "utf8");
    } catch {
      contents = "";
    }
    const unique = candidates.filter((c, i) => c !== "" && candidates.indexOf(c) === i);
    return { file, version: extractVersion(contents), candidates: unique };
  }
  return null;
}

/** Ranked most explicit first: a `self-update` means itself, `update` might not. */
export const SELF_UPDATE_WORDS = ["self-update", "selfupdate", "self_update", "upgrade", "update"];
/** An indented listing line: two spaces, a word, then columns or arguments. */
export const HELP_LINE = /^\s{1,8}([A-Za-z][A-Za-z0-9_-]*)(.*)$/;

/**
 * Reads a tool's own `--help` and returns the subcommand that updates the tool
 * itself, or null. We never assume `mytool update` exists: an invented command
 * printed as a suggestion is worse than admitting we don't know one.
 *
 * A listed subcommand that takes a required argument — `update <path>` — is
 * rejected, because it updates whatever you hand it, not itself.
 */
export function findSelfUpdateSubcommand(helpText: string): string | null {
  const found = new Map<string, boolean>();
  for (const line of helpText.split("\n")) {
    const match = HELP_LINE.exec(line);
    if (!match?.[1]) continue;
    const word = match[1].toLowerCase();
    if (!SELF_UPDATE_WORDS.includes(word)) continue;

    const rest = match[2] ?? "";
    // Only a columnar listing counts; a sentence starting with "update" doesn't.
    if (rest !== "" && !/^(\s{2,}|\s*[<[])/.test(rest)) continue;
    // The argument column is whatever comes before the description gap.
    const args = rest.split(/\s{2,}/)[0]?.trim() ?? "";
    const takesRequiredArg = /^<[^>]+>/.test(args);
    if (!found.has(word) || found.get(word) === false) found.set(word, !takesRequiredArg);
  }
  for (const word of SELF_UPDATE_WORDS) {
    if (found.get(word) === true) return word;
  }
  return null;
}

export async function askForVersion(exec: ExecRunner, tool: string): Promise<string | null> {
  for (const args of [["--version"], ["version"]]) {
    const result = await exec(tool, args);
    if (result.failure === "missing") return null;
    const version = extractVersion(`${result.stdout}\n${result.stderr}`);
    if (version) return version;
  }
  return null;
}

export async function readHelp(exec: ExecRunner, tool: string): Promise<string | null> {
  for (const args of [["--help"], ["help"]]) {
    const result = await exec(tool, args);
    if (result.failure === "missing") return null;
    const text = `${result.stdout}\n${result.stderr}`.trim();
    if (text !== "") return text;
  }
  return null;
}

export async function checkTool(
  skill: SkillInfo,
  dir: string,
  marker: VersionMarker,
  toolName: string,
  toolPath: string,
  options: ResolvedOptions,
): Promise<ToolUpdateCheck> {
  const installedToolVersion = await askForVersion(options.exec, toolName);
  const markerVersion = marker.version;
  const markerFileName = path.basename(marker.file);

  let status: UpdateStatus = "unknown";
  let summary = "Can't tell";
  let detail: string;

  if (!markerVersion) {
    detail = `${markerFileName} doesn't contain a version that can be read, so there is nothing to compare with the ${toolName} on your PATH.`;
  } else if (!installedToolVersion) {
    detail = `This skill was installed for ${toolName} ${markerVersion}, but ${toolName} didn't report a version, so there is nothing to compare.`;
  } else {
    const order = compareVersions(markerVersion, installedToolVersion);
    if (order === null) {
      detail = `This skill records ${markerVersion} and ${toolName} reports ${installedToolVersion}; those can't be put in order.`;
    } else if (order < 0) {
      status = "behind";
      summary = `Update available: ${markerVersion} → ${installedToolVersion}`;
      detail = `These skill files were installed for ${toolName} ${markerVersion}, but the ${toolName} on your PATH is ${installedToolVersion}. Reinstall the skill from the newer ${toolName} to catch up.`;
    } else if (order === 0) {
      status = "up-to-date";
      summary = `Up to date (${markerVersion})`;
      detail = `These skill files match the ${toolName} ${installedToolVersion} on your PATH.`;
    } else {
      // The skill is ahead of the binary. Something is stale, but it isn't the
      // skill, and guessing which way the user wants it resolved is not ours.
      detail = `These skill files are from ${toolName} ${markerVersion}, which is newer than the ${installedToolVersion} on your PATH — the command is the older half here.`;
    }
  }

  const help = await readHelp(options.exec, toolName);
  const subcommand = help ? findSelfUpdateSubcommand(help) : null;
  const command = subcommand ? makeCommand([toolName, subcommand], false) : null;
  if (!command) {
    detail += ` ${toolName} doesn't list a command for updating itself, so how it gets updated is up to however you installed it.`;
  }

  return {
    skill,
    dir,
    method: "tool",
    status,
    summary,
    detail,
    command,
    markerFile: marker.file,
    markerVersion,
    toolName,
    toolPath,
    installedToolVersion,
  };
}

// ---------------------------------------------------------------------------
// 4. Manual — nothing on disk knows where this came from
// ---------------------------------------------------------------------------

export function checkManual(
  skill: SkillInfo,
  dir: string,
  marker: VersionMarker | null,
  options: ResolvedOptions,
): ManualUpdateCheck {
  const fileStats = statOrNull(skill.filePath);
  const dirStats = statOrNull(dir);
  const times = [fileStats?.mtime, dirStats?.mtime].filter((d): d is Date => d instanceof Date);
  const lastModified = times.length ? times.reduce((newest, d) => (d > newest ? d : newest)) : null;

  let detail = `Nothing on this computer records where this skill came from — it isn't part of an installed bundle, it isn't a git clone, and there's no version file next to it. It lives in ${dir}`;
  detail += lastModified
    ? `, last changed on ${formatDay(lastModified)} (${describeAge(lastModified, options.now)}).`
    : ".";
  if (marker) {
    detail += ` There is a ${path.basename(marker.file)} here, but no matching command is installed, so it can't be checked.`;
  }

  return {
    skill,
    dir,
    method: "manual",
    status: "unknown",
    summary: lastModified
      ? `No update path — last changed ${formatDay(lastModified)}`
      : "No update path",
    detail,
    command: null,
    lastModified,
    markerFile: marker?.file ?? null,
  };
}
