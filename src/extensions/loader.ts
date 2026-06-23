// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

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
import { isNewer } from "@/update/semver";
import { repoFor } from "./sources";
import { useExtStoreUI, type ExtUpdateInfo } from "./store-ui";
import { getSettings } from "@/state/settings-store";
import {
  loadTrustList,
  bannedReasonForManifest,
  flagBannedExtension,
} from "./trust";

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
  // Cache-bust by version: the renderer caches a dynamic import() by URL, so
  // without a per-version query an updated bundle keeps running the module that
  // was imported at launch. Bumping the manifest version now re-imports it.
  const url = `${location.origin}/__plugins__/${manifest.id}/${manifest.main}?v=${encodeURIComponent(manifest.version)}`;
  const mod = (await import(/* @vite-ignore */ url)) as Partial<ExtensionModule>;
  if (typeof mod.activate !== "function")
    throw new Error(`${manifest.id}: bundle has no activate(api) export`);
  mod.activate(makeScopedAPI(manifest.id));
  loaded.set(manifest.id, mod as ExtensionModule);
}

/** After a background trust refresh, retire any loaded external extension the
 *  list now bans — the remote kill-switch taking effect on its own schedule.
 *  Only touches banned extensions; everything else keeps running untouched. */
async function enforceBansOnLoaded(): Promise<void> {
  const native = window.safelightNative;
  if (!native) return;
  let list: ExtensionManifest[];
  try {
    list = await native.plugins.list();
  } catch {
    return;
  }
  for (const m of list) {
    if (!loaded.has(m.id)) continue;
    const banned = bannedReasonForManifest(m);
    if (!banned) continue;
    flagBannedExtension({ id: m.id, name: m.name, reason: banned });
    console.warn(`[extensions] disabling now-banned ${m.id}: ${banned}`);
    loaded.get(m.id)?.deactivate?.();
    loaded.delete(m.id);
    unregisterExtension(m.id);
  }
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
    // Kill-switch check against the cached trust list (seeded synchronously from
    // localStorage) — no fetch to await, so themes and panels activate at once.
    // A banned extension is never activated; we flag it (banner + console) rather
    // than silently dropping it, so the user knows why it stopped working.
    const banned = bannedReasonForManifest(manifest);
    if (banned) {
      flagBannedExtension({ id: manifest.id, name: manifest.name, reason: banned });
      console.warn(`[extensions] blocked ${manifest.id}: ${banned}`);
      continue;
    }
    try {
      await loadPlugin(manifest);
    } catch (e) {
      console.error(`[extensions] failed to load ${manifest.id}:`, e);
    }
  }
  // The saved theme may belong to a plugin that just registered it.
  applySavedTheme();
  // Refresh the trust list from the network in the background (force: bypass the
  // cache TTL so registry edits — new bans, new verifications — show up on the
  // next launch, not up to a TTL later), then retire anything it now bans. This
  // is off the hot path: activation above already happened from the cached list.
  if (list.length > 0) void loadTrustList(true).then(enforceBansOnLoaded);
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
  // Updating over a live version: tear the old one down and drop it from the
  // loaded set so loadPlugin re-imports the freshly-downloaded bundle (the
  // versioned URL above makes that a real re-import, not a cache hit).
  const prev = loaded.get(manifest.id);
  if (prev) {
    prev.deactivate?.();
    loaded.delete(manifest.id);
    unregisterExtension(manifest.id);
  }
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

// ─── Updates ───────────────────────────────────────────────────────────────
// An extension's latest version is the newest non-draft GitHub release tag of
// the repo it was installed from. We require Releases (the same convention the
// app's own updater uses) — a repo with no releases simply has "no update info".

const UPDATE_CHECK_TTL = 6 * 60 * 60 * 1000; // re-check at most every 6h

/** The version in the repo's default-branch safelight.json, or null. This is the
 *  same field the installed manifest exposes, so a pushed version bump is an
 *  update — no GitHub Release required (install/browse already track HEAD). */
async function latestRepoVersion(fullName: string): Promise<string | null> {
  const native = window.safelightNative;
  if (!native?.plugins?.latestVersion) return null;
  return native.plugins.latestVersion(fullName);
}

/** Check one installed extension for a newer version and cache the result.
 *  Returns the cached result when checked within the TTL (unless `force`). */
export async function checkExtensionUpdate(
  manifest: ExtensionManifest,
  force = false,
): Promise<ExtUpdateInfo | null> {
  const repo = repoFor(manifest);
  if (!repo) return null; // built-in / custom import with no known repo
  const cached = useExtStoreUI.getState().updates[manifest.id];
  if (!force && cached && Date.now() - cached.checkedAt < UPDATE_CHECK_TTL)
    return cached;
  let latest: string | null = null;
  try {
    latest = await latestRepoVersion(repo);
  } catch {
    return cached ?? null; // network hiccup — keep any prior result
  }
  const info: ExtUpdateInfo = {
    latestTag: latest,
    hasUpdate: !!latest && isNewer(manifest.version, latest),
    checkedAt: Date.now(),
  };
  useExtStoreUI.getState().setUpdate(manifest.id, info);
  return info;
}

/** Reinstall an extension from its repo's HEAD, preserving settings and enabled
 *  state. The install overwrites <userData>/plugins/<id>/ in place. The third
 *  arg (the detected latest version) is informational; the install always pulls
 *  HEAD, whose latest commit carries that version (bumps aren't git tags). */
export async function updateExtension(
  id: string,
  fullName: string,
  _version: string,
): Promise<ExtensionManifest> {
  // Tear down the running instance, then reinstall live. Settings are
  // deliberately NOT deleted (unlike uninstall) so the update is seamless.
  loaded.get(id)?.deactivate?.();
  loaded.delete(id);
  unregisterExtension(id);
  const manifest = await installFromGitHub(fullName); // HEAD = latest version
  useExtStoreUI.getState().setUpdate(id, {
    latestTag: manifest.version,
    hasUpdate: false,
    checkedAt: Date.now(),
  });
  return manifest;
}

/** Background check on launch: refresh update info for every installed
 *  extension, and auto-update when the user has opted in. Throttled so we don't
 *  fire a burst of GitHub requests. Gated by the checkExtensionUpdates setting. */
export async function checkAllExtensionUpdates(): Promise<void> {
  const native = window.safelightNative;
  if (!native?.plugins?.latestVersion) return;
  const settings = getSettings();
  if (!settings.checkExtensionUpdates) return;
  let list: ExtensionManifest[];
  try {
    list = await native.plugins.list();
  } catch {
    return;
  }
  const CONCURRENCY = 3;
  for (let i = 0; i < list.length; i += CONCURRENCY) {
    const slice = list.slice(i, i + CONCURRENCY);
    await Promise.all(
      slice.map(async (m) => {
        const info = await checkExtensionUpdate(m);
        if (info?.hasUpdate && info.latestTag && settings.autoUpdateExtensions) {
          const repo = repoFor(m);
          if (repo) {
            try {
              await updateExtension(m.id, repo, info.latestTag);
            } catch (e) {
              console.error(`[extensions] auto-update failed for ${m.id}:`, e);
            }
          }
        }
      }),
    );
  }
}
