// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Starter kits for the welcome setup: curated groups of verified extensions,
// published as kits.json in the trust registry (see the registry's
// validate-kits.mjs, which enforces the same rules before publishing). The
// file is remote data, so it is checked again here: anything malformed is
// dropped rather than shown half-broken, and only schema 1 is read, because a
// breaking change ships as a new file name that older builds never fetch.

import { isNewer, isSemver } from "@/update/semver";

export const KIT_ICONS = [
  "film",
  "palette",
  "detail",
  "organise",
  "speed",
  "import",
  "style",
] as const;
export type KitIcon = (typeof KIT_ICONS)[number];

export interface KitExtension {
  /** "owner/repo", lowercased: the install spec, and the key for trust
   *  lookups, the installed check and de-duplication across kits. */
  repo: string;
  name: string;
  summary: string;
}

export interface StarterKit {
  id: string;
  name: string;
  description: string;
  /** null when the file names an icon this build doesn't draw. */
  icon: KitIcon | null;
  extensions: KitExtension[];
}

export const KIT_LIMITS = {
  kits: 8,
  extensionsPerKit: 12,
  kitName: 40,
  kitDescription: 160,
  extensionName: 48,
  extensionSummary: 140,
} as const;

const KIT_ID = /^[a-z0-9-]{1,32}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const text = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

function parseExtension(raw: unknown, appVersion: string): KitExtension | null {
  if (!isRecord(raw)) return null;
  const repo = typeof raw.repo === "string" ? raw.repo.trim().toLowerCase() : "";
  const name = text(raw.name, KIT_LIMITS.extensionName);
  if (!REPO.test(repo) || !name) return null;
  const min = raw.minAppVersion;
  if (typeof min === "string" && isSemver(min) && isNewer(appVersion, min))
    return null;
  return { repo, name, summary: text(raw.summary, KIT_LIMITS.extensionSummary) };
}

function parseKit(raw: unknown, appVersion: string): StarterKit | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id : "";
  const name = text(raw.name, KIT_LIMITS.kitName);
  if (!KIT_ID.test(id) || !name || !Array.isArray(raw.extensions)) return null;
  const seen = new Set<string>();
  const extensions: KitExtension[] = [];
  for (const item of raw.extensions) {
    const ext = parseExtension(item, appVersion);
    if (!ext || seen.has(ext.repo)) continue;
    seen.add(ext.repo);
    extensions.push(ext);
    if (extensions.length === KIT_LIMITS.extensionsPerKit) break;
  }
  if (extensions.length === 0) return null;
  return {
    id,
    name,
    description: text(raw.description, KIT_LIMITS.kitDescription),
    icon: KIT_ICONS.find((icon) => icon === raw.icon) ?? null,
    extensions,
  };
}

/** The kits in a kits.json document, in file order; null when the document
 *  isn't a schema-1 kits file at all. */
export function parseKits(raw: unknown, appVersion: string): StarterKit[] | null {
  if (!isRecord(raw) || raw.schema !== 1 || !Array.isArray(raw.kits)) return null;
  const ids = new Set<string>();
  const kits: StarterKit[] = [];
  for (const item of raw.kits) {
    const kit = parseKit(item, appVersion);
    if (!kit || ids.has(kit.id)) continue;
    ids.add(kit.id);
    kits.push(kit);
    if (kits.length === KIT_LIMITS.kits) break;
  }
  return kits;
}
