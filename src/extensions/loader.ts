// Extension lifecycle: loads built-in (pre-installed) and external extensions,
// and owns the enable/disable state. External plugins live in
// <userData>/plugins/<id>/ on disk, are served by the Electron app:// protocol
// under /__plugins__/, and are dynamic-imported as ESM. They never bundle
// React — they use api.react.
//
// Disabling an extension deactivates it and sweeps its registry contributions
// (panels, themes, layouts, settings) but keeps its files and stored settings.
// Uninstalling (external only) deletes both.

import { create } from "zustand";
import type { ExtensionManifest, ExtensionModule } from "./types";
import { unregisterExtension } from "./registry";
import { applySavedTheme } from "./themes";
import { makeScopedAPI } from "./host";
import { deleteExtensionSettings } from "./ext-settings";
import { BUILTIN_EXTENSIONS } from "./builtin";

const loaded = new Map<string, ExtensionModule>();

// ─── Enable / disable state (persisted, synced across windows) ──────────────

const DISABLED_KEY = "sl_ext_disabled";

function loadDisabled(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(DISABLED_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export const useDisabledExtensions = create<{ ids: string[] }>(() => ({
  ids: loadDisabled(),
}));

export const isExtensionDisabled = (id: string): boolean =>
  useDisabledExtensions.getState().ids.includes(id);

function persistDisabled(ids: string[]): void {
  useDisabledExtensions.setState({ ids });
  try {
    localStorage.setItem(DISABLED_KEY, JSON.stringify(ids));
  } catch {}
}

/** Activate/deactivate in this window (state is already persisted). */
async function applyEnablement(id: string, enabled: boolean): Promise<void> {
  const builtin = BUILTIN_EXTENSIONS.find((b) => b.id === id);
  if (!enabled) {
    if (builtin) {
      builtin.deactivate?.(); // tear down side effects (e.g. console patches)
    } else {
      loaded.get(id)?.deactivate?.();
      loaded.delete(id);
    }
    unregisterExtension(id);
    return;
  }
  if (builtin) {
    builtin.activate(makeScopedAPI(id));
  } else {
    const native = window.safelightNative;
    if (!native) return;
    const manifest = (await native.plugins.list()).find((m) => m.id === id);
    if (manifest) await loadPlugin(manifest);
  }
  applySavedTheme(); // the saved theme may belong to the re-enabled extension
}

export async function setExtensionEnabled(
  id: string,
  enabled: boolean,
): Promise<void> {
  if (BUILTIN_EXTENSIONS.find((b) => b.id === id)?.locked) return;
  const ids = useDisabledExtensions.getState().ids.filter((x) => x !== id);
  if (!enabled) ids.push(id);
  persistDisabled(ids);
  await applyEnablement(id, enabled);
}

/** Follow enable/disable made in other windows. Call once at boot. */
export function initEnablement(): void {
  window.addEventListener("storage", (e) => {
    if (e.key !== DISABLED_KEY || e.newValue == null) return;
    let next: string[];
    try {
      next = JSON.parse(e.newValue);
    } catch {
      return;
    }
    const prev = useDisabledExtensions.getState().ids;
    useDisabledExtensions.setState({ ids: next });
    for (const id of next.filter((x) => !prev.includes(x)))
      void applyEnablement(id, false);
    for (const id of prev.filter((x) => !next.includes(x)))
      void applyEnablement(id, true);
  });
}

// ─── Disabled-by-default seeding ───────────────────────────────────────────
// Some built-ins (e.g. Developer Tools) ship inactive. They can't simply be
// added to the disabled list at build time — that would re-disable them every
// launch even after the user enables them. Instead we seed each such id into
// the disabled list exactly once and remember that we did, so the user's later
// choice is what sticks. New default-off built-ins added in future versions are
// seeded on the first launch that includes them.

const SEEDED_KEY = "sl_ext_default_seeded";

function loadSeeded(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(SEEDED_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function seedDefaultDisabled(): void {
  const seeded = loadSeeded();
  const newlySeeded = BUILTIN_EXTENSIONS.filter(
    (b) => b.disabledByDefault && !b.locked && !seeded.includes(b.id),
  ).map((b) => b.id);
  if (newlySeeded.length === 0) return;

  const disabled = useDisabledExtensions.getState().ids;
  const nextDisabled = [...disabled];
  for (const id of newlySeeded)
    if (!nextDisabled.includes(id)) nextDisabled.push(id);
  persistDisabled(nextDisabled);
  try {
    localStorage.setItem(SEEDED_KEY, JSON.stringify([...seeded, ...newlySeeded]));
  } catch {}
}

// ─── Loading ─────────────────────────────────────────────────────────────────

/** Activate every built-in extension that isn't disabled. */
export function loadBuiltins(): void {
  seedDefaultDisabled(); // default-off built-ins start disabled on first launch
  for (const ext of BUILTIN_EXTENSIONS) {
    if (ext.locked || !isExtensionDisabled(ext.id)) {
      ext.activate(makeScopedAPI(ext.id));
    }
  }
}

async function loadPlugin(manifest: ExtensionManifest): Promise<void> {
  if (loaded.has(manifest.id)) return;
  const url = `${location.origin}/__plugins__/${manifest.id}/${manifest.main}`;
  const mod = (await import(/* @vite-ignore */ url)) as Partial<ExtensionModule>;
  if (typeof mod.activate !== "function")
    throw new Error(`${manifest.id}: bundle has no activate(api) export`);
  mod.activate(makeScopedAPI(manifest.id));
  loaded.set(manifest.id, mod as ExtensionModule);
}

export async function loadExternalPlugins(): Promise<void> {
  const native = window.safelightNative;
  if (!native) return; // plain-browser dev build
  let list: ExtensionManifest[] = [];
  try {
    list = await native.plugins.list();
  } catch {
    return;
  }
  for (const manifest of list) {
    if (isExtensionDisabled(manifest.id)) continue;
    try {
      await loadPlugin(manifest);
    } catch (e) {
      console.error(`[extensions] failed to load ${manifest.id}:`, e);
    }
  }
  // The saved theme may belong to a plugin that just registered it.
  applySavedTheme();
}

export async function installFromGitHub(
  spec: string,
): Promise<ExtensionManifest> {
  const native = window.safelightNative;
  if (!native) throw new Error("Requires the desktop app.");
  const manifest = await native.plugins.install(spec);
  // A fresh install always starts enabled.
  persistDisabled(
    useDisabledExtensions.getState().ids.filter((x) => x !== manifest.id),
  );
  await loadPlugin(manifest); // live, no restart
  return manifest;
}

export async function uninstallPlugin(id: string): Promise<void> {
  const native = window.safelightNative;
  loaded.get(id)?.deactivate?.();
  loaded.delete(id);
  unregisterExtension(id);
  deleteExtensionSettings(id); // forget its persisted settings too
  persistDisabled(useDisabledExtensions.getState().ids.filter((x) => x !== id));
  await native?.plugins.uninstall(id); // deletes <userData>/plugins/<id>/
}
