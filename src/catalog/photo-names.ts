// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Which file names are photos. Free of the DOM, so the GUI's import and the
// `safelight` CLI share one rule.

import photoTypes from "../../electron/photo-types.json";
import { RAW_EXTENSIONS, getExtension } from "@/raw/raw-preview";

export const STANDARD_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(photoTypes.standard));

/** Whether `name` is a photo the app opens, by its extension alone. */
export function isSupportedName(name: string): boolean {
  const ext = getExtension(name);
  return STANDARD_EXTENSIONS.has(ext) || RAW_EXTENSIONS.has(ext);
}
