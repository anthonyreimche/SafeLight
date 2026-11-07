// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The official extensions: the ones Safelight publishes from its own
// repositories, which hold the ids under "safelight". The list itself is
// electron/official-extensions.json, which the main process reads too
// (electron/extension-origins.cjs). A leaf module like core-extension.ts: the
// loaders and the dev folder import it.

import list from "../../electron/official-extensions.json";
import type { ExtensionManifest } from "./types";
import { isReservedExtensionId, reservedIdReason } from "./core-extension";

export interface OfficialExtension {
  id: string;
  /** "owner/repo" it installs and updates from, and the manifest `repository`
   *  it names. */
  repo: string;
  /** Other names its manifest may give as `repository`: the ones its
   *  releases were published under before `repo` was corrected. */
  aliases?: readonly string[];
  /** The built-in extension it takes over from, or null when it has none (the
   *  Library and Develop modules are not extensions). */
  replaces: string | null;
  /** Part of the Essentials kit. */
  essential: boolean;
  /** Saved layouts never switch it on or off. */
  keepAcrossLayouts: boolean;
}

export const OFFICIAL_EXTENSIONS: readonly OfficialExtension[] = list.extensions;

/** Developer Tools: the one extension handed api.devtools, and the one the
 *  Extensions ▸ Dev tab and the top bar's bug button ride along with. */
export const DEVTOOLS_EXTENSION_ID = "safelight.devtools";

/** Accessibility: the overlays and the switches the welcome setup shows. */
export const ACCESSIBILITY_EXTENSION_ID = "safelight.accessibility";

/** The registry kit (kits.json) that holds the essentials. */
export const ESSENTIALS_KIT_ID = "essentials";

const OFFICIAL_ID_PREFIX = "safelight";

/** An id only the official extensions may hold: "safelight" and everything
 *  under "safelight.", compared without case like the reserved ids.
 *  electron/extension-origins.cjs states the same rule for the main process. */
export function isOfficialOnlyId(id: string): boolean {
  const lower = id.toLowerCase();
  return lower === OFFICIAL_ID_PREFIX || lower.startsWith(`${OFFICIAL_ID_PREFIX}.`);
}

/** The list row for `id`, if it is an official extension's. */
export const officialExtension = (id: string): OfficialExtension | undefined =>
  OFFICIAL_EXTENSIONS.find((e) => e.id === id);

type ManifestIds = Pick<ExtensionManifest, "id" | "repository">;

/** Whether the list has `m`'s id and `m` names that row's repository or one
 *  of its aliases. */
export function isOfficialManifest(m: ManifestIds): boolean {
  const row = officialExtension(m.id);
  if (!row || typeof m.repository !== "string") return false;
  const named = m.repository.toLowerCase();
  return [row.repo, ...(row.aliases ?? [])].some((r) => r.toLowerCase() === named);
}

const officialIdReason = (id: string): string =>
  `${id}: extension ids under '${OFFICIAL_ID_PREFIX}' are reserved for Safelight's official extensions`;

/** Why an installed or dev-folder extension may not run under its id, or null
 *  when it may: an id under "core", or one under "safelight" that isn't an
 *  official extension from its own repository. */
export function manifestIdRefusal(m: ManifestIds): string | null {
  if (isReservedExtensionId(m.id)) return reservedIdReason(m.id);
  if (isOfficialOnlyId(m.id) && !isOfficialManifest(m)) return officialIdReason(m.id);
  return null;
}
