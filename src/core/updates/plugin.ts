import path from "node:path";
import type { SkillInfo } from "../skills.js";
import { findOnPath } from "./exec.js";
import type { PluginUpdateCheck, ResolvedOptions, UpdateStatus } from "./types.js";
import { asRecord, asString, describeAge, makeCommand, readJsonFile } from "./util.js";
import { compareVersions } from "./versions.js";

/** Checker 1: an installed plugin vs the marketplace catalogue on disk. Part of core/updates.ts — see the overview there. */

// ---------------------------------------------------------------------------
// 1. Plugin — installed bundle vs the marketplace catalogue on disk
// ---------------------------------------------------------------------------

export interface InstalledPluginRecord {
  scope: string | null;
  installPath: string | null;
  version: string | null;
  lastUpdated: string | null;
}

export function readInstalledPlugin(
  home: string,
  pluginId: string,
  skillPath: string,
): InstalledPluginRecord | null {
  const file = path.join(home, ".claude", "plugins", "installed_plugins.json");
  const plugins = asRecord(asRecord(readJsonFile(file))?.["plugins"]);
  const installs = plugins?.[pluginId];
  if (!Array.isArray(installs) || installs.length === 0) return null;

  const records: InstalledPluginRecord[] = [];
  for (const raw of installs) {
    const entry = asRecord(raw);
    if (!entry) continue;
    records.push({
      scope: asString(entry["scope"]),
      installPath: asString(entry["installPath"]),
      version: asString(entry["version"]),
      lastUpdated: asString(entry["lastUpdated"]) ?? asString(entry["installedAt"]),
    });
  }
  if (records.length === 0) return null;

  // The same bundle can be installed at several scopes; prefer the copy this
  // skill actually came out of.
  const owning = records.find(
    (r) => r.installPath !== null && skillPath.startsWith(r.installPath + path.sep),
  );
  return owning ?? records[0] ?? null;
}

export interface CatalogEntry {
  version: string | null;
  ref: string | null;
  found: boolean;
}

export function readCatalogEntry(
  home: string,
  marketplace: string,
  pluginName: string,
): CatalogEntry {
  const known = asRecord(
    readJsonFile(path.join(home, ".claude", "plugins", "known_marketplaces.json")),
  );
  const installLocation = asString(asRecord(known?.[marketplace])?.["installLocation"]);
  if (!installLocation) return { version: null, ref: null, found: false };

  const catalog = asRecord(
    readJsonFile(path.join(installLocation, ".claude-plugin", "marketplace.json")),
  );
  const entries = catalog?.["plugins"];
  if (!Array.isArray(entries)) return { version: null, ref: null, found: false };

  for (const raw of entries) {
    const entry = asRecord(raw);
    if (!entry || entry["name"] !== pluginName) continue;
    // `source` is either a string path or an object describing a git source.
    const ref = asString(asRecord(entry["source"])?.["ref"]);
    return { version: asString(entry["version"]), ref, found: true };
  }
  return { version: null, ref: null, found: false };
}

export function checkPlugin(
  skill: SkillInfo,
  dir: string,
  pluginId: string,
  options: ResolvedOptions,
): PluginUpdateCheck {
  const at = pluginId.lastIndexOf("@");
  const pluginName = at > 0 ? pluginId.slice(0, at) : pluginId;
  const marketplace = at > 0 ? pluginId.slice(at + 1) : "";

  const installed = readInstalledPlugin(options.home, pluginId, skill.filePath);
  const catalog =
    marketplace === ""
      ? { version: null, ref: null, found: false }
      : readCatalogEntry(options.home, marketplace, pluginName);

  const installedVersion = installed?.version ?? null;
  const catalogVersion = catalog.version;

  let status: UpdateStatus = "unknown";
  let summary = "Can't tell";
  let detail: string;

  if (!installed) {
    detail = `Claude Code has no installation record for ${pluginId}, so there is nothing to compare.`;
  } else if (!catalog.found) {
    detail = `The ${marketplace} catalogue on this computer has no entry for ${pluginName}, so there is nothing to compare it against.`;
  } else if (!catalogVersion) {
    // Most catalogue entries genuinely carry no version. That is a real
    // "unknown", and calling it "up to date" would be inventing information.
    detail =
      `You have ${installedVersion ?? "an unrecorded version"}. The ${marketplace} catalogue doesn't publish a version for ` +
      `${pluginName}, so nothing on this computer can say whether that is the latest.`;
  } else if (!installedVersion) {
    detail = `The catalogue lists ${catalogVersion}, but Claude Code didn't record which version you installed.`;
  } else {
    const order = compareVersions(installedVersion, catalogVersion);
    if (order === null) {
      detail = `You have ${installedVersion} and the catalogue lists ${catalogVersion}; those aren't version numbers that can be put in order.`;
    } else if (order < 0) {
      status = "behind";
      summary = `Update available: ${installedVersion} → ${catalogVersion}`;
      detail = `You have ${installedVersion}. The ${marketplace} catalogue lists ${catalogVersion}.`;
    } else if (order === 0) {
      status = "up-to-date";
      summary = `Up to date (${installedVersion})`;
      detail = `You have ${installedVersion}, which is what the ${marketplace} catalogue lists.`;
    } else {
      detail = `You have ${installedVersion}, which is newer than the ${catalogVersion} in the ${marketplace} catalogue — the catalogue copy is probably out of date.`;
    }
  }

  if (installed?.lastUpdated) {
    const when = new Date(installed.lastUpdated);
    if (!Number.isNaN(when.getTime())) {
      detail += ` Installed ${describeAge(when, options.now)}.`;
    }
  }

  // `claude plugin update <id>` is the supported way to move a bundle, but
  // only offer it if the CLI is actually here — no shelling out to find out.
  const claudePath = findOnPath("claude", options.env);
  const command = claudePath ? makeCommand(["claude", "plugin", "update", pluginId], true) : null;
  if (!claudePath) {
    detail += " The `claude` command isn't on your PATH, so there's nothing to run from here.";
  }

  return {
    skill,
    dir,
    method: "plugin",
    status,
    summary,
    detail,
    command,
    pluginId,
    pluginName,
    marketplace,
    installedVersion,
    catalogVersion,
    catalogRef: catalog.ref,
    installPath: installed?.installPath ?? null,
    lastUpdated: installed?.lastUpdated ?? null,
  };
}
