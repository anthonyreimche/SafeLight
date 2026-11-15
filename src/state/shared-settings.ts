// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Files the app writes into userData so `slu` and the engine can see what lives
// in the app profile's localStorage and in running extensions. The app writes
// them; `slu` and the engine only read them.

/** The repository the app installed each extension from, by id (src/extensions/sources.ts). */
export const APP_SOURCES_KEY = "sl_ext_sources";

/** localStorage keys copied verbatim. Prefix entries end with "*". */
export const MIRRORED_STORAGE_KEYS: readonly string[] = [
  "sl_settings_v1", "sl_pipeline", "safelight-presets", "sl_ext_settings_*",
  // The extension holding the input-profile resolver, which a non-RAW photo waits for.
  "safelight.inputProfileOwner",
  APP_SOURCES_KEY,
];

export interface SharedSettings {
  version: 1;
  appVersion: string;
  writtenAt: number;          // when the content last changed; readers take the newer heartbeat (GUI_HEARTBEAT_FILE)
  guiPid: number | null;
  recentProjects: string[];   // absolute paths, newest first
  storage: Record<string, string>;  // key → raw localStorage value
}

export interface ExtensionDescriptors {
  version: 1;
  id: string;
  extVersion: string;
  name: string;
  writtenAt: number;
  stages: { id: string; phase: string; priority?: number; after?: string[]; anchor?: string }[];
  uniforms: { key: string; glslType: string; default: unknown; range?: { min: number; max: number; step?: number }; label?: string }[];
  panels: { id: string; title: string; owns?: string[] }[];
  hasCatalogHooks: boolean;
}

export const SHARED_SETTINGS_FILE = "shared-settings.json";        // in userData
export const GUI_HEARTBEAT_FILE = "gui-heartbeat.json";            // { version: 1, writtenAt: number }
export const DESCRIPTORS_DIR = "extension-descriptors";            // <id>@<version>.json
export const EXTENSION_STATE_FILE = "extension-state.json";        // { version: 1, disabled: string[] }

/** How often a main window sends its settings, which marks the heartbeat, and how
 *  old a heartbeat may be while `slu` still takes the app to be open. */
export const GUI_HEARTBEAT_MS = 60_000;
export const GUI_HEARTBEAT_FRESH_MS = 150_000;

export function descriptorFileName(id: string, version: string): string {
  return `${id}@${version}.json`;
}
