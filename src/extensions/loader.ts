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
import type {
  ExtensionManifest,
  ExtensionModule,
  ModuleId,
  RemoteManifest,
} from "./types";
import { moduleEntry, unregisterExtension, useRegistry } from "./registry";
import { useUIStore } from "@/state/ui-store";
import { applySavedTheme } from "./themes";
import { makeScopedAPI } from "./host";
import { deleteExtensionSettings } from "./ext-settings";
import { setExtensionName } from "./param-registry";
import { BUILTIN_EXTENSIONS, type BuiltinExtension } from "./builtin";
import { isReservedExtensionId, reservedIdReason } from "./core-extension";
import { isNewer, isPrerelease } from "@/update/semver";
import { repoFor } from "./sources";
import { useExtStoreUI, type ExtUpdateInfo } from "./store-ui";
import { importPluginModule } from "./plugin-module";
import { getSettings } from "@/state/settings-store";
import {
  loadTrustList,
  bannedReasonForManifest,
  flagBannedExtension,
} from "./trust";
import {
  type ExtensionKind,
  extensionKinds,
  forgetExtension,
  noteExtensionRunning,
} from "./extension-kinds";
import { keptVersion, setKept } from "./pins";

const loaded = new Map<string, ExtensionModule>();

// ─── Enable / disable state (persisted, synced across windows) ──────────────

const DISABLED_KEY = "sl_ext_disabled";

function parseDisabled(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function loadDisabled(): string[] {
  return parseDisabled(localStorage.getItem(DISABLED_KEY));
}

export const useDisabledExtensions = create<{ ids: string[] }>(() => ({
  ids: loadDisabled(),
}));

/** False until the first pass over installed plugins has finished (or was
 *  skipped: no bridge). A detached window shows a "waiting" placeholder for a
 *  registered module until then, and "unavailable" after. */
export const useExternalPluginsSettled = create<{ settled: boolean }>(() => ({
  settled: false,
}));

export const isExtensionDisabled = (id: string): boolean =>
  useDisabledExtensions.getState().ids.includes(id);

function persistDisabled(ids: string[]): void {
  useDisabledExtensions.setState({ ids });
  try {
    localStorage.setItem(DISABLED_KEY, JSON.stringify(ids));
  } catch {}
}

// Built-ins running in this window. A built-in's activate() isn't safe to run
// twice, so turning on one that is already running leaves it alone.
const activeBuiltins = new Set<string>();

function activateBuiltin(ext: BuiltinExtension): void {
  ext.activate(makeScopedAPI(ext.id));
  activeBuiltins.add(ext.id);
  noteExtensionRunning(ext.id);
}

/** Activate/deactivate in this window (state is already persisted). An
 *  extension already in the requested state is left as it is. */
async function applyEnablement(id: string, enabled: boolean): Promise<void> {
  const builtin = BUILTIN_EXTENSIONS.find((b) => b.id === id);
  if (!enabled) {
    if (builtin) {
      // tear down side effects (e.g. console patches)
      if (activeBuiltins.delete(id)) builtin.deactivate?.();
    } else {
      loaded.get(id)?.deactivate?.();
      loaded.delete(id);
    }
    unregisterExtension(id);
    return;
  }
  if (builtin) {
    if (activeBuiltins.has(id)) return;
    activateBuiltin(builtin);
  } else {
    const native = window.safelightNative;
    if (!native) return;
    const manifest = (await native.plugins.list()).find((m) => m.id === id);
    if (!manifest) return;
    const banned = bannedReasonForManifest(manifest);
    if (banned) {
      flagBannedExtension({ id: manifest.id, name: manifest.name, reason: banned });
      console.warn(`[extensions] blocked ${manifest.id}: ${banned}`);
      return;
    }
    await loadPlugin(manifest);
  }
  applySavedTheme(); // the saved theme may belong to the re-enabled extension
}

// Changes run one at a time, in the order they were asked for. Starting an
// external extension waits on its import, so a change overlapping one still in
// flight could leave the extension running while it is recorded as off, or
// start it twice.
let enablementQueue: Promise<unknown> = Promise.resolve();

function queueEnablement<T>(change: () => Promise<T>): Promise<T> {
  const run = enablementQueue.then(() => change());
  enablementQueue = run.catch(() => {});
  return run;
}

export async function setExtensionEnabled(
  id: string,
  enabled: boolean,
): Promise<void> {
  if (BUILTIN_EXTENSIONS.find((b) => b.id === id)?.locked) return;
  const ids = useDisabledExtensions.getState().ids.filter((x) => x !== id);
  if (!enabled) ids.push(id);
  persistDisabled(ids);
  await queueEnablement(() => applyEnablement(id, enabled));
}

/** Follow enable/disable made in other windows. Call once at boot. */
export function initEnablement(): void {
  window.addEventListener("storage", (e) => {
    if (e.key !== DISABLED_KEY || e.newValue == null) return;
    const next = parseDisabled(e.newValue);
    const prev = useDisabledExtensions.getState().ids;
    useDisabledExtensions.setState({ ids: next });
    for (const id of next.filter((x) => !prev.includes(x)))
      void queueEnablement(() => applyEnablement(id, false));
    for (const id of prev.filter((x) => !next.includes(x)))
      void queueEnablement(() => applyEnablement(id, true));
  });
}

// ─── Saved layouts ─────────────────────────────────────────────────────────
// A saved layout remembers which extensions that only add interface (panels,
// tools, themes) are on, so picking it can switch them off for room and memory.
// It never switches the locked core, a built-in kept across layouts, or an
// extension that renders into photos, nor one never seen running, which could
// be either.

/** Whether a saved layout may switch `id` on or off, given what each
 *  extension has been seen doing. */
function layoutSwitches(id: string, kinds: Record<string, ExtensionKind>): boolean {
  const builtin = BUILTIN_EXTENSIONS.find((b) => b.id === id);
  if (builtin?.locked || builtin?.keepAcrossLayouts) return false;
  return Object.hasOwn(kinds, id) && kinds[id] === "interface";
}

/** On/off, as the user has them now, for every extension a layout switches. */
export function captureLayoutExtensions(): Record<string, boolean> {
  const kinds = extensionKinds();
  const states: Record<string, boolean> = {};
  for (const id of Object.keys(kinds))
    if (layoutSwitches(id, kinds)) states[id] = !isExtensionDisabled(id);
  return states;
}

/** The entries of `states` a layout may switch that differ from the user's. */
function layoutChanges(states: Record<string, boolean>): [string, boolean][] {
  const kinds = extensionKinds();
  return Object.entries(states).filter(
    (e): e is [string, boolean] =>
      typeof e[1] === "boolean" &&
      layoutSwitches(e[0], kinds) &&
      e[1] !== !isExtensionDisabled(e[0]),
  );
}

/** True when applying `states` would switch nothing. */
export function layoutExtensionsMatch(states: Record<string, boolean>): boolean {
  return layoutChanges(states).length === 0;
}

/** Switch extensions to the states a saved layout remembers, after any change
 *  already under way, and resolve once they are running or stopped. One no
 *  longer installed, or banned since, is left alone. The disabled list is
 *  written once, so other windows follow the whole switch from one change; an
 *  extension that fails to start is logged and the rest still switch. */
export function applyLayoutExtensions(states: Record<string, boolean>): Promise<void> {
  return queueEnablement(async () => {
    const changes = layoutChanges(states);
    if (changes.length === 0) return;
    let installed: ExtensionManifest[] = [];
    try {
      installed = (await window.safelightNative?.plugins.list()) ?? [];
    } catch {}
    const switchable = changes.filter(([id]) => {
      if (BUILTIN_EXTENSIONS.some((b) => b.id === id)) return true;
      const m = installed.find((x) => x.id === id);
      return !!m && !bannedReasonForManifest(m);
    });
    if (switchable.length === 0) return;
    const on = switchable.filter(([, enabled]) => enabled).map(([id]) => id);
    const off = switchable.filter(([, enabled]) => !enabled).map(([id]) => id);
    persistDisabled([
      ...useDisabledExtensions.getState().ids.filter((x) => !on.includes(x)),
      ...off,
    ]);
    const turn = async (id: string, enabled: boolean) => {
      try {
        await applyEnablement(id, enabled);
      } catch (e) {
        console.error(`[extensions] the layout could not switch ${id}:`, e);
      }
    };
    // Stop first, so what starts next has the memory the others gave back.
    for (const id of off) await turn(id, false);
    for (const id of on) await turn(id, true);
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
      setExtensionName(ext.id, ext.name);
      activateBuiltin(ext);
    }
  }
}

/** Import and activate an installed extension. Every caller goes through here, so
 *  the refusal of a reserved id (core-extension.ts) comes before the bundle is
 *  even imported. */
async function loadPlugin(manifest: ExtensionManifest): Promise<void> {
  if (isReservedExtensionId(manifest.id)) throw new Error(reservedIdReason(manifest.id));
  if (loaded.has(manifest.id)) return;
  // Cache-bust by version: the renderer caches a dynamic import() by URL, so
  // without a per-version query an updated bundle keeps running the module that
  // was imported at launch. Bumping the manifest version now re-imports it.
  const url = `${location.origin}/__plugins__/${manifest.id}/${manifest.main}?v=${encodeURIComponent(manifest.version)}`;
  const mod = await importPluginModule(url);
  if (typeof mod.activate !== "function")
    throw new Error(`${manifest.id}: bundle has no activate(api) export`);
  setExtensionName(manifest.id, manifest.name);
  try {
    mod.activate(makeScopedAPI(manifest.id));
  } catch (e) {
    unregisterExtension(manifest.id); // whatever it registered before throwing
    throw e;
  }
  loaded.set(manifest.id, mod as ExtensionModule);
  noteExtensionRunning(manifest.id);
}

/** Stop a running external extension and sweep its contributions. A reserved id
 *  is never one: it is Safelight's own, so sweeping it would take Safelight's
 *  contributions with it. */
function teardown(id: string): void {
  if (isReservedExtensionId(id)) return;
  loaded.get(id)?.deactivate?.();
  loaded.delete(id);
  unregisterExtension(id);
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
    teardown(m.id);
  }
}

export async function loadExternalPlugins(): Promise<void> {
  try {
    await queueEnablement(loadExternalPluginsOnce);
  } finally {
    useExternalPluginsSettled.setState({ settled: true });
  }
}

async function loadExternalPluginsOnce(): Promise<void> {
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
  // Deliberately not gated on checkExtensionUpdates: a kill-switch is not an
  // update check, and the cache it corrects lives in localStorage, which the
  // extensions themselves can write.
  if (list.length > 0) void loadTrustList(true).then(enforceBansOnLoaded);
}

// ─── Install / update ───────────────────────────────────────────────────────
// Both paths put the new files on disk first (the main process keeps the version
// being replaced aside), then swap the live instance, then settle: "keep" drops
// the previous copy, "rollback" restores it. Nothing in the renderer changes
// until the download and validation have succeeded, so a failed update leaves
// the running extension exactly as it was.

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const settle = (
  id: string,
  outcome: "keep" | "rollback",
): Promise<ExtensionManifest | null> =>
  window.safelightNative?.plugins?.settleUpdate?.(id, outcome) ?? Promise.resolve(null);

/** The record for an installed version with nothing newer known. */
const upToDate = (version: string): ExtUpdateInfo => ({
  latestTag: version,
  hasUpdate: false,
  requiresApp: null,
  failed: null,
  checkedAt: Date.now(),
});

/** The module the main window is showing, if `extensionId` contributed it. */
function shownModuleOf(extensionId: string): ModuleId | null {
  const active = useUIStore.getState().activeModule;
  return moduleEntry(useRegistry.getState().modules, active)?.extensionId === extensionId
    ? active
    : null;
}

/** Tearing an extension down sends the main window from its module to Library
 *  (ModuleView). Once a version of the extension has registered the module
 *  again, go back to it, unless the user has moved on from Library since. */
function returnToModule(module: ModuleId | null): void {
  const ui = useUIStore.getState();
  if (
    module &&
    ui.activeModule === "library" &&
    moduleEntry(useRegistry.getState().modules, module)
  )
    ui.setActiveModule(module);
}

/** Drop the previous copy after a successful swap. Failing to do so is not a
 *  failed update: the next launch's sweep treats the leftover as unsettled and
 *  puts the previous version back, and the update is offered again. */
async function keepSettled(id: string): Promise<void> {
  try {
    await settle(id, "keep");
  } catch (e) {
    console.warn(`[extensions] could not settle the update of ${id}:`, e);
  }
}

/** The latest install requested for each repo, with the version it asked for. */
const inflight = new Map<string, { version?: string; run: Promise<ExtensionManifest> }>();

/** Download `spec` and put it live. `enable` clears the disabled flag first (a
 *  fresh install always starts enabled); an update leaves the user's choice
 *  alone, so a disabled extension gets the new files and stays off. One install
 *  per repo at a time, since they write the same folder: a request for the
 *  version already in flight (or queued) joins it, and a different version waits
 *  until the install ahead of it settles, success or failure. */
function installAndActivate(
  spec: string,
  enable: boolean,
  version?: string,
): Promise<ExtensionManifest> {
  const key = spec.trim().toLowerCase();
  const prior = inflight.get(key);
  if (prior && prior.version === version) return prior.run;
  const run = prior
    ? prior.run.catch(() => undefined).then(() => performInstall(spec, enable, version))
    : performInstall(spec, enable, version);
  const entry = { version, run };
  inflight.set(key, entry);
  const forget = () => {
    if (inflight.get(key) === entry) inflight.delete(key);
  };
  run.then(forget, forget);
  return run;
}

async function performInstall(
  spec: string,
  enable: boolean,
  version?: string,
): Promise<ExtensionManifest> {
  const native = window.safelightNative;
  if (!native) throw new Error("Requires the desktop app.");
  const manifest = await (version
    ? native.plugins.install(spec, version)
    : native.plugins.install(spec));
  const { id } = manifest;
  if (enable)
    persistDisabled(useDisabledExtensions.getState().ids.filter((x) => x !== id));
  const store = useExtStoreUI.getState();
  if (isExtensionDisabled(id)) {
    await keepSettled(id);
    store.setUpdate(id, upToDate(manifest.version));
    return manifest;
  }
  const shown = shownModuleOf(id);
  teardown(id);
  try {
    await loadPlugin(manifest);
  } catch (e) {
    let message = `${manifest.name} ${manifest.version} failed to start (${errorText(e)})`;
    let restored: ExtensionManifest | null = null;
    let removed = false;
    try {
      restored = await settle(id, "rollback");
      removed = restored === null;
    } catch (settleError) {
      // The previous copy is still in the work area; the next launch puts it back.
      message += `; rollback failed (${errorText(settleError)})`;
    }
    if (restored) {
      try {
        await loadPlugin(restored);
        returnToModule(shown);
        applySavedTheme();
        message += `; ${restored.version} was restored`;
      } catch (restoreError) {
        message += `; restoring ${restored.version} also failed (${errorText(restoreError)})`;
      }
    }
    if (removed) {
      store.clearUpdate(id); // nothing is installed any more
    } else {
      store.setUpdate(id, {
        latestTag: manifest.version,
        hasUpdate: true,
        requiresApp: null,
        failed: { version: manifest.version, error: errorText(e) },
        checkedAt: Date.now(),
      });
    }
    throw new Error(message);
  }
  returnToModule(shown);
  await keepSettled(id);
  applySavedTheme(); // the saved theme may belong to the extension just loaded
  store.setUpdate(id, upToDate(manifest.version));
  return manifest;
}

/** Install `spec` from GitHub: its latest release (or its branch when it
 *  publishes no releases), or the release `version` when given. */
export const installFromGitHub = (spec: string, version?: string): Promise<ExtensionManifest> =>
  installAndActivate(spec, true, version);

/** Reinstall an installed extension at `version` (the one its update check
 *  offered), keeping its settings and its enabled/disabled state. Updating
 *  stops keeping an older version. */
export async function updateExtension(
  fullName: string,
  version?: string,
): Promise<ExtensionManifest> {
  const manifest = await installAndActivate(fullName, false, version);
  setKept(manifest.id, null);
  return manifest;
}

export async function uninstallPlugin(id: string): Promise<void> {
  const native = window.safelightNative;
  teardown(id);
  deleteExtensionSettings(id); // forget its persisted settings too
  useExtStoreUI.getState().clearUpdate(id); // and its cached update check
  setKept(id, null); // and any version it was kept at
  forgetExtension(id); // and what it was seen doing, for saved layouts
  persistDisabled(useDisabledExtensions.getState().ids.filter((x) => x !== id));
  await native?.plugins.uninstall(id); // deletes <userData>/plugins/<id>/
}

// ─── Updates ───────────────────────────────────────────────────────────────
// An extension's latest version is its newest GitHub release, or the `version`
// in its default-branch safelight.json when it publishes no releases; the main
// process reads both from the registry index when that lists the repo. Someone
// on a pre-release is also offered newer pre-releases. The remote minAppVersion
// travels with it: a release this build can't run is reported (requiresApp)
// rather than offered.

// How long a per-extension check is reused before we re-query GitHub. Kept short
// so opening the store (or relaunching) surfaces a freshly-pushed version quickly;
// the persisted cache still paints the last-known badge instantly while the
// refresh runs, so a short TTL costs latency only on the network round-trip.
const UPDATE_CHECK_TTL = 30 * 60 * 1000; // 30 min

// Re-run the whole sweep on this cadence so a version bumped while the app is
// left open is noticed without a restart. host.ts owns the interval.
export const EXT_UPDATE_POLL_MS = 3 * 60 * 60 * 1000; // 3h

/** The update record for an installed version given what the repo publishes.
 *  A failure recorded in `prior` is kept only while the same version is still
 *  the latest, so a fixed release clears it on its own. */
export function classifyUpdate(
  installed: string,
  remote: RemoteManifest | null,
  appVersion: string,
  prior: ExtUpdateInfo | undefined,
  now: number,
): ExtUpdateInfo {
  const latestTag = remote?.version ?? null;
  const hasUpdate = !!latestTag && isNewer(installed, latestTag);
  const minApp = remote?.minAppVersion;
  return {
    latestTag,
    hasUpdate,
    requiresApp: hasUpdate && minApp && isNewer(appVersion, minApp) ? minApp : null,
    failed: prior?.failed && prior.failed.version === latestTag ? prior.failed : null,
    checkedAt: now,
  };
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
  const fetchRemote = window.safelightNative?.plugins?.remoteManifest;
  if (!fetchRemote) return null;
  let remote: RemoteManifest | null;
  try {
    remote = await (isPrerelease(manifest.version)
      ? fetchRemote(repo, { prerelease: true })
      : fetchRemote(repo));
  } catch {
    return cached ?? null; // network hiccup — keep any prior result
  }
  const info = classifyUpdate(manifest.version, remote, __APP_VERSION__, cached, Date.now());
  useExtStoreUI.getState().setUpdate(manifest.id, info);
  return info;
}

/** Auto-update maintains what the user is running: it skips a version this
 *  build can't host, one that already failed to start here, an extension kept
 *  at an older version, and any extension the user has turned off. */
const autoInstallable = (m: ExtensionManifest, info: ExtUpdateInfo): boolean =>
  info.hasUpdate &&
  !!info.latestTag &&
  !info.requiresApp &&
  info.failed?.version !== info.latestTag &&
  !keptVersion(m.id) &&
  !isExtensionDisabled(m.id);

/** Refresh update info for every installed extension, and auto-update the ones
 *  autoInstallable allows when the user has opted in. Gated by the
 *  checkExtensionUpdates setting. Pass `force` to bypass the per-extension TTL
 *  (used by the periodic poll so it always re-checks).
 *
 *  Checks run through a bounded worker pool rather than fixed batches: there's no
 *  barrier between items, so one slow repo can't hold up the rest and the sweep
 *  finishes in roughly a single round-trip instead of ceil(N / batch) waves. */
export async function checkAllExtensionUpdates(force = false): Promise<void> {
  const native = window.safelightNative;
  if (!native?.plugins?.remoteManifest) return;
  const settings = getSettings();
  if (!settings.checkExtensionUpdates) return;
  let list: ExtensionManifest[];
  try {
    list = await native.plugins.list();
  } catch {
    return;
  }
  const CONCURRENCY = 8;
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const m = list[next++];
      const info = await checkExtensionUpdate(m, force);
      if (!settings.autoUpdateExtensions || !info || !autoInstallable(m, info)) continue;
      const repo = repoFor(m);
      if (!repo) continue;
      try {
        await updateExtension(repo, info.latestTag ?? undefined);
      } catch (e) {
        console.error(`[extensions] auto-update failed for ${m.id}:`, e);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker),
  );
}
