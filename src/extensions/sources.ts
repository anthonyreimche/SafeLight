// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Remembers which GitHub repo ("owner/repo") each installed extension came from.
// The Browse list uses it to tell which official results are already installed,
// and the detail view + update checker use it to find an installed extension's
// repo. What we recorded at install time wins over the manifest's self-declared
// `repository`, which only answers for extensions we never installed ourselves —
// dev folders, branch pins, and imports that predate this record.

import type { ExtensionManifest } from "./types";

const SOURCES_KEY = "sl_ext_sources";

export const readSources = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(SOURCES_KEY) ?? "{}");
  } catch {
    return {};
  }
};

export const rememberSource = (manifestId: string, fullName: string): void => {
  try {
    localStorage.setItem(
      SOURCES_KEY,
      JSON.stringify({ ...readSources(), [manifestId]: fullName.toLowerCase() }),
    );
  } catch {}
};

export const forgetSource = (manifestId: string): void => {
  try {
    const { [manifestId]: _omit, ...rest } = readSources();
    localStorage.setItem(SOURCES_KEY, JSON.stringify(rest));
  } catch {}
};

// Drop remembered sources whose extension is no longer installed (e.g. an
// uninstall that never cleaned up) so search results don't stay "Installed".
export const pruneSources = (installed: ExtensionManifest[]): void => {
  const src = readSources();
  const ids = new Set(installed.map((m) => m.id));
  const kept = Object.entries(src).filter(([id]) => ids.has(id));
  if (kept.length !== Object.keys(src).length) {
    try {
      localStorage.setItem(SOURCES_KEY, JSON.stringify(Object.fromEntries(kept)));
    } catch {}
  }
};

/** The "owner/repo" for an installed extension: the repo we installed it from,
 *  falling back to the manifest's declared `repository`. Null when neither
 *  exists. Not a trust lookup — the fallback is the extension's own word, so
 *  ban checks go through bannedReasonForManifest instead. */
export const repoFor = (manifest: ExtensionManifest): string | null => {
  const source = readSources()[manifest.id];
  if (source) return source;
  return manifest.repository && /^[\w.-]+\/[\w.-]+$/.test(manifest.repository)
    ? manifest.repository
    : null;
};
