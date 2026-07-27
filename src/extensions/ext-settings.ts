// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Per-extension persisted settings. One localStorage entry per extension
// (sl_ext_settings_<id>), mirrored into a reactive zustand store so settings
// dialogs update live, and synced across windows via the storage event.
// Uninstalling an extension deletes its stored values.

import { create } from "zustand";

const PREFIX = "sl_ext_settings_";
const storageKey = (id: string) => `${PREFIX}${id}`;

type Values = Record<string, unknown>;

function load(id: string): Values {
  try {
    return JSON.parse(localStorage.getItem(storageKey(id)) ?? "{}");
  } catch {
    return {};
  }
}

/** extensionId → its settings values (loaded lazily). */
export const useExtSettings = create<Record<string, Values>>(() => ({}));

// No setState here: getExtSetting runs during render, so populating the cache
// lazily would mean updating the store mid-render.
function valuesFor(id: string): Values {
  return useExtSettings.getState()[id] ?? load(id);
}

const listeners = new Map<string, Set<(key: string, value: unknown) => void>>();

function notify(id: string, key: string, value: unknown): void {
  listeners.get(id)?.forEach((cb) => cb(key, value));
}

/** Everything the extension has stored (for the generic settings dialog). */
export function getAllExtSettings(id: string): Values {
  return valuesFor(id);
}

export function getExtSetting<T>(id: string, key: string, fallback: T): T {
  const v = valuesFor(id)[key];
  return v === undefined ? fallback : (v as T);
}

export function setExtSetting(id: string, key: string, value: unknown): void {
  const next = { ...valuesFor(id), [key]: value };
  useExtSettings.setState({ [id]: next });
  try {
    localStorage.setItem(storageKey(id), JSON.stringify(next));
  } catch {}
  notify(id, key, value);
}

export function onExtSettingChange(
  id: string,
  cb: (key: string, value: unknown) => void,
): () => void {
  let set = listeners.get(id);
  if (!set) listeners.set(id, (set = new Set()));
  set.add(cb);
  return () => set.delete(cb);
}

/** Remove an uninstalled extension's stored settings. */
export function deleteExtensionSettings(id: string): void {
  try {
    localStorage.removeItem(storageKey(id));
  } catch {}
  useExtSettings.setState((s) => {
    const { [id]: _, ...rest } = s;
    return rest;
  }, true);
  listeners.delete(id);
}

/** Follow changes made in other windows. Call once at boot. */
export function initExtSettings(): void {
  window.addEventListener("storage", (e) => {
    if (!e.key?.startsWith(PREFIX)) return;
    const id = e.key.slice(PREFIX.length);
    // A removal (newValue == null) is another window deleting this extension's
    // settings — drop the id so stale values don't linger here.
    if (e.newValue == null) {
      useExtSettings.setState((s) => {
        const { [id]: _, ...rest } = s;
        return rest;
      }, true);
      return;
    }
    try {
      const prev = useExtSettings.getState()[id] ?? {};
      const next = JSON.parse(e.newValue) as Values;
      useExtSettings.setState({ [id]: next });
      for (const k of Object.keys(next)) {
        if (next[k] !== prev[k]) notify(id, k, next[k]);
      }
    } catch {}
  });
}
