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
import type { ExtensionManifest, ExtensionModule, ModuleId, RemoteManifest } from "./types";
import { fallbackModule, moduleEntry, useRegistry } from "./registry";
import { useUIStore } from "@/state/ui-store";
import { applySavedTheme } from "./themes";
import { deleteExtensionSettings } from "./ext-settings";
import { setExtensionName } from "./param-registry";
import { BUILTIN_EXTENSIONS } from "./builtin";
import { isReservedExtensionId } from "./core-extension";
import { manifestIdRefusal, officialExtension } from "./official-extensions";
import { isNewer, isPrerelease } from "@/update/semver";
import { updateRepoFor } from "./sources";
import { useExtStoreUI, type ExtUpdateInfo } from "./store-ui";
import { importPluginModule } from "./plugin-module";
import { getSettings } from "@/state/settings-store";
import { privilegedPlugins } from "@/native/privileged";
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
import {
  builtinExtension,
  isBuiltinActive,
  isInstanceLive,
  startBuiltin,
  startInstance,
  stopBuiltin,
  stopInstance,
  takeDisplaced,
} from "./instance";
import { keptVersion, setKept } from "./pins";
import { useRunningPlugins } from "./running-plugins";

export { useRunningPlugins };

/** Whether an installed extension is running in this window. */
export const isPluginRunning = (id: string): boolean => isInstanceLive(id);

/** React hook: whether an installed extension is running in this window, that
 *  is installed, turned on and started. */
export const usePluginRunning = (id: string): boolean =>
  useRunningPlugins((s) => s.ids.includes(id));

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

/** The ids of the installed external plugins, as the launch pass listed them;
 *  null until it has. */
export const useInstalledPlugins = create<{ ids: string[] | null }>(() => ({
  ids: null,
}));

export const isExtensionDisabled = (id: string): boolean =>
  useDisabledExtensions.getState().ids.includes(id);

function persistDisabled(ids: string[]): void {
  useDisabledExtensions.setState({ ids });
  try {
    localStorage.setItem(DISABLED_KEY, JSON.stringify(ids));
  } catch {}
}

/** A manifest the trust list bans is flagged, logged as `verdict` and refused;
 *  true when it is. */
function refuseIfBanned(manifest: ExtensionManifest, verdict: string): boolean {
  const banned = bannedReasonForManifest(manifest);
  if (!banned) return false;
  flagBannedExtension({ id: manifest.id, name: manifest.name, reason: banned });
  console.warn(`[extensions] ${verdict} ${manifest.id}: ${banned}`);
  return true;
}

/** Activate/deactivate in this window (state is already persisted). An
 *  extension already in the requested state is left as it is. */
async function applyEnablement(id: string, enabled: boolean): Promise<void> {
  const builtin = builtinExtension(id);
  if (!enabled) {
    if (builtin) stopBuiltin(builtin);
    else stopInstance(id, "installed");
    return;
  }
  if (builtin) {
    if (isBuiltinActive(id)) return;
    startBuiltin(builtin);
  } else {
    const native = window.safelightNative;
    if (!native) return;
    const manifest = (await native.plugins.list()).find((m) => m.id === id);
    if (!manifest) return;
    if (refuseIfBanned(manifest, "blocked")) return;
    await loadPlugin(manifest);
  }
  applySavedTheme(); // the saved theme may belong to the re-enabled extension
}

// Changes run one at a time, in the order they were asked for. Starting an
// external extension waits on its import, so a change overlapping one still in
// flight could leave the extension running while it is recorded as off, or
// start it twice.
let enablementQueue: Promise<unknown> = Promise.resolve();
let queuedChanges = 0;

function queueEnablement<T>(change: () => Promise<T>): Promise<T> {
  queuedChanges++;
  const run = enablementQueue
    .then(() => change())
    .finally(() => {
      queuedChanges--;
    });
  enablementQueue = run.catch(() => {});
  return run;
}

/** True while a change asked for earlier hasn't finished: the disabled list
 *  may not yet say what extensions will end up on. */
export const enablementPending = (): boolean => queuedChanges > 0;

let recordLayoutExtension: ((id: string, enabled: boolean) => void) | null = null;

/** The dock sets how a layout showing remembers a change made to an extension
 *  outside it. The dock imports this module, so it supplies the call. */
export function onLayoutExtensionToggled(record: (id: string, enabled: boolean) => void): void {
  recordLayoutExtension = record;
}

export async function setExtensionEnabled(
  id: string,
  enabled: boolean,
): Promise<void> {
  if (builtinExtension(id)?.locked) return;
  const ids = useDisabledExtensions.getState().ids.filter((x) => x !== id);
  if (!enabled) ids.push(id);
  persistDisabled(ids);
  if (layoutSwitches(id, extensionKinds())) recordLayoutExtension?.(id, enabled);
  await queueEnablement(() => applyEnablement(id, enabled));
}

/** Follow enable/disable made in other windows. Call once at boot. */
export function initEnablement(): void {
  const follow = (id: string, enabled: boolean) =>
    queueEnablement(() => applyEnablement(id, enabled)).catch((e: unknown) => {
      console.warn(
        `[extensions] following ${enabled ? "enable" : "disable"} of ${id} from another window failed:`,
        e,
      );
    });
  window.addEventListener("storage", (e) => {
    if (e.key !== DISABLED_KEY || e.newValue == null) return;
    const next = parseDisabled(e.newValue);
    const prev = useDisabledExtensions.getState().ids;
    useDisabledExtensions.setState({ ids: next });
    for (const id of next.filter((x) => !prev.includes(x))) void follow(id, false);
    for (const id of prev.filter((x) => !next.includes(x))) void follow(id, true);
  });
}

// ─── Saved layouts ─────────────────────────────────────────────────────────
// A saved layout the user lets switch extensions turns the ones they tick on
// and the rest off, for room and memory. Only extensions that just add
// interface (panels, tools, themes) can be ticked: never the locked core, a
// built-in kept across layouts, or an extension that renders into photos, nor
// one never seen running, which could be either.

/** Why a saved layout never switches an extension. */
export type LayoutExtensionHold = "pixels" | "unseen" | "kept";

/** Whether saved layouts leave `id` as the user set it: a built-in that says
 *  so, or an official extension whose list row does. A manifest can't claim it. */
export function keepsAcrossLayouts(id: string): boolean {
  const builtin = builtinExtension(id);
  if (builtin) return !!builtin.keepAcrossLayouts;
  return officialExtension(id)?.keepAcrossLayouts ?? false;
}

/** Why a saved layout never switches `id`, given what each extension has been
 *  seen doing, or null when it may. */
function layoutHold(
  id: string,
  kinds: Record<string, ExtensionKind>,
): LayoutExtensionHold | null {
  if (builtinExtension(id)?.locked || keepsAcrossLayouts(id)) return "kept";
  if (!Object.hasOwn(kinds, id)) return "unseen";
  return kinds[id] === "pixels" ? "pixels" : null;
}

function layoutSwitches(id: string, kinds: Record<string, ExtensionKind>): boolean {
  return layoutHold(id, kinds) === null;
}

export interface LayoutExtensionChoice {
  id: string;
  name: string;
  hold: LayoutExtensionHold | null;
}

/** Every extension a layout's checklist lists, by name: the built-ins but the
 *  locked core, and `installed` but banned ones. */
export function layoutExtensionChoices(
  installed: ExtensionManifest[],
): LayoutExtensionChoice[] {
  const kinds = extensionKinds();
  const choice = (id: string, name: string): LayoutExtensionChoice => ({
    id,
    name,
    hold: layoutHold(id, kinds),
  });
  const external = installed.filter(
    (m) => !bannedReasonForManifest(m) && !builtinExtension(m.id),
  );
  return [
    ...BUILTIN_EXTENSIONS.filter((b) => !b.locked).map((b) => choice(b.id, b.name)),
    ...external.map((m) => choice(m.id, m.name)),
  ].sort((a, b) => a.name.localeCompare(b.name));
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
      if (builtinExtension(id)) return true;
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
// A built-in can ship inactive (disabledByDefault). It can't simply be added
// to the disabled list at build time: that would disable it again every launch
// after the user enables it. Instead we seed each such id into
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
      startBuiltin(ext);
    }
  }
}

/** Import and activate an installed extension. Every caller goes through here, so
 *  the refusal of a reserved or unofficial official-only id
 *  (official-extensions.ts) comes before the bundle is even imported. */
async function loadPlugin(manifest: ExtensionManifest, ahead?: BundleAhead): Promise<void> {
  const refusal = manifestIdRefusal(manifest);
  if (refusal) throw new Error(refusal);
  const { id } = manifest;
  if (isInstanceLive(id)) return;
  const url = bundleUrl(manifest);
  await startInstance({
    id,
    source: "installed",
    name: manifest.name,
    bundle: url,
    read: async () => ({ load: ahead?.load ?? (() => importPluginModule(url)) }),
    // The user may turn the extension off while its bundle is still on the way.
    stillWanted: ahead && (() => !isExtensionDisabled(id)),
  });
  if (isInstanceLive(id)) noteExtensionRunning(id);
}

// Cache-bust by version: the renderer caches a dynamic import() by URL, so
// without a per-version query an updated bundle keeps running the module that
// was imported at launch. Bumping the manifest version now re-imports it.
const bundleUrl = (manifest: ExtensionManifest): string =>
  `${location.origin}/__plugins__/${manifest.id}/${manifest.main}?v=${encodeURIComponent(manifest.version)}`;

/** How many bundles are imported at once while the installed extensions start. */
const IMPORT_CONCURRENCY = 6;

/** A bundle already being imported for a start that comes later. */
interface BundleAhead {
  /** Its import. A bundle still waiting its turn to import starts now, so one
   *  that never finishes can't keep those after it from starting. */
  load(): Promise<Partial<ExtensionModule>>;
}

/** Begin importing `manifests`' bundles, up to IMPORT_CONCURRENCY at a time and
 *  in list order, ahead of the starts that wait on them. A failed import is
 *  reported when its extension's turn comes, not before. */
function importAhead(manifests: ExtensionManifest[]): Map<ExtensionManifest, BundleAhead> {
  const ahead = new Map<ExtensionManifest, BundleAhead>();
  const waiting: (() => void)[] = [];
  let importing = 0;
  const startWaiting = () => {
    while (importing < IMPORT_CONCURRENCY && waiting.length > 0) waiting.shift()?.();
  };
  for (const manifest of manifests) {
    let begin = () => {};
    const imported = new Promise<Partial<ExtensionModule>>((resolve, reject) => {
      let begun = false;
      begin = () => {
        if (begun) return;
        begun = true;
        importing++;
        new Promise<Partial<ExtensionModule>>((started) => started(importPluginModule(bundleUrl(manifest))))
          .then(resolve, reject)
          .finally(() => {
            importing--;
            startWaiting();
          });
      };
    });
    imported.catch(() => {});
    waiting.push(begin);
    ahead.set(manifest, {
      load: () => {
        begin();
        return imported;
      },
    });
  }
  startWaiting();
  return ahead;
}

/** Stop a running installed extension and sweep its contributions; a copy of the
 *  id loaded from the dev folder keeps running. A reserved id is never one: it
 *  is Safelight's own, so sweeping it would take Safelight's contributions with
 *  it. */
function teardown(id: string): void {
  if (isReservedExtensionId(id)) return;
  stopInstance(id, "installed");
}

/** Start again the installed extensions a dev-folder copy stopped, now that the
 *  copy has unloaded. One the user turned off meanwhile stays off. */
export function restoreDisplacedPlugins(): Promise<void> {
  const ids = takeDisplaced().filter((id) => !isExtensionDisabled(id));
  if (ids.length === 0) return Promise.resolve();
  return queueEnablement(async () => {
    let list: ExtensionManifest[];
    try {
      list = (await window.safelightNative?.plugins.list()) ?? [];
    } catch {
      return;
    }
    for (const manifest of list) {
      if (!ids.includes(manifest.id) || isExtensionDisabled(manifest.id)) continue;
      if (refuseIfBanned(manifest, "blocked")) continue;
      try {
        await loadPlugin(manifest);
      } catch (e) {
        console.error(`[extensions] failed to restore ${manifest.id}:`, e);
      }
    }
    applySavedTheme();
  });
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
    if (isInstanceLive(m.id, "installed") && refuseIfBanned(m, "disabling now-banned"))
      teardown(m.id);
  }
}

/** Let queued input and paint run: activations that settle from cached bundles
 *  would otherwise chain in microtasks into one long task. */
function yieldToEventLoop(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  // Not a timer: fake and throttled timers would stretch the yield.
  if (typeof MessageChannel === "undefined") return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(null);
  });
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
  useInstalledPlugins.setState({ ids: list.map((m) => m.id) });
  // Bundles import side by side; the extensions still activate one at a time in
  // list order, so what they register lands in the same order on every launch.
  const ahead = importAhead(
    list.filter(
      (m) =>
        !isExtensionDisabled(m.id) &&
        !bannedReasonForManifest(m) &&
        !manifestIdRefusal(m) &&
        !isInstanceLive(m.id),
    ),
  );
  let first = true;
  for (const manifest of list) {
    if (isExtensionDisabled(manifest.id)) continue;
    // Kill-switch check against the cached trust list (seeded synchronously from
    // localStorage) — no fetch to await, so themes and panels activate at once.
    // A banned extension is never activated; we flag it (banner + console) rather
    // than silently dropping it, so the user knows why it stopped working.
    if (refuseIfBanned(manifest, "blocked")) continue;
    if (!first) await yieldToEventLoop();
    first = false;
    try {
      await loadPlugin(manifest, ahead.get(manifest));
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
  privilegedPlugins()?.settleUpdate(id, outcome) ?? Promise.resolve(null);

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

/** Tearing an extension down sends the main window from its module to the
 *  first other tab (ModuleView), or leaves it there when there is none. Once a
 *  version of the extension has registered the module again, go back to it,
 *  unless the user has moved on from that tab since. */
function returnToModule(module: ModuleId | null): void {
  if (!module) return;
  const ui = useUIStore.getState();
  const fellBackTo = fallbackModule(module) ?? module;
  if (ui.activeModule === fellBackTo && moduleEntry(useRegistry.getState().modules, module))
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

/** When an install was asked for, and the id it installs once that is known. */
interface InstallTicket {
  asked: number;
  id?: string;
}

interface InflightInstall {
  version?: string;
  ticket: InstallTicket;
  /** Settles once this request's own download and swap have. */
  done: Promise<ExtensionManifest>;
  /** What its callers get: its own outcome, or that of a newer install of the
   *  repo that superseded it. */
  result: Promise<ExtensionManifest>;
}

/** The latest install requested for each repo. */
const inflight = new Map<string, InflightInstall>();

/** Orders install and uninstall requests, so an install can tell whether its
 *  extension was uninstalled after it was asked for. */
let changeRequests = 0;
const uninstalledAt = new Map<string, number>();

const uninstalledSince = ({ asked, id }: InstallTicket): boolean =>
  id !== undefined && (uninstalledAt.get(id) ?? 0) > asked;

/** Why a downloaded install no longer goes live. */
type Superseded = "uninstalled" | "newer";

/** An install that downloaded but was not started: the extension was
 *  uninstalled, or a newer install of it asked for, while it downloaded. Its
 *  callers see "uninstalled" only; one superseded by a newer install answers
 *  with that install's outcome instead. */
export class InstallSupersededError extends Error {
  readonly reason: Superseded;
  constructor(manifest: ExtensionManifest, reason: Superseded) {
    super(
      `${manifest.name} ${manifest.version} was not started: ` +
        (reason === "uninstalled"
          ? "it was uninstalled while it downloaded"
          : "a newer install of it was asked for"),
    );
    this.name = "InstallSupersededError";
    this.reason = reason;
  }
}

/** Download `spec` and put it live. `enable` clears the disabled flag first (a
 *  fresh install always starts enabled); an update leaves the user's choice
 *  alone, so a disabled extension gets the new files and stays off. One install
 *  per repo at a time, since they write the same folder: a request for the
 *  version already in flight (or queued) joins it, unless the extension was
 *  uninstalled since, and a different version waits until the install ahead of
 *  it settles, success or failure, then supersedes it. The download runs beside
 *  other changes; the swap waits its turn on the enablement queue. */
function installAndActivate(
  spec: string,
  enable: boolean,
  version?: string,
  expectedId?: string,
): Promise<ExtensionManifest> {
  const key = spec.trim().toLowerCase();
  const prior = inflight.get(key);
  if (prior && prior.version === version && !uninstalledSince(prior.ticket)) return prior.result;
  const ticket: InstallTicket = { asked: ++changeRequests, id: expectedId };
  const isLatest = () => inflight.get(key) === entry;
  const perform = () => performInstall(spec, enable, ticket, isLatest, version, expectedId);
  const done = prior ? prior.done.catch(() => undefined).then(perform) : perform();
  const result = done.catch((e: unknown) => {
    const newer = inflight.get(key);
    if (e instanceof InstallSupersededError && e.reason === "newer" && newer && newer !== entry)
      return newer.result;
    throw e;
  });
  const entry: InflightInstall = { version, ticket, done, result };
  inflight.set(key, entry);
  const forget = () => {
    if (inflight.get(key) === entry) inflight.delete(key);
  };
  done.then(forget, forget);
  return result;
}

/** Drop a download that won't go live. An uninstalled extension keeps no files;
 *  otherwise the copy from before the download is put back (or, for a first
 *  install, nothing is), for the newer install to replace. */
async function discardDownload(id: string, reason: Superseded): Promise<void> {
  try {
    if (reason === "uninstalled") {
      await settle(id, "keep");
      await privilegedPlugins()?.uninstall(id);
    } else {
      await settle(id, "rollback");
    }
  } catch (e) {
    console.warn(`[extensions] could not discard the download of ${id}:`, e);
  }
}

async function performInstall(
  spec: string,
  enable: boolean,
  ticket: InstallTicket,
  isLatest: () => boolean,
  version?: string,
  expectedId?: string,
): Promise<ExtensionManifest> {
  const plugins = privilegedPlugins();
  if (!plugins) throw new Error("Requires the desktop app.");
  const manifest = await (version ? plugins.install(spec, version) : plugins.install(spec));
  const { id } = manifest;
  ticket.id = id;
  if (expectedId !== undefined && id !== expectedId) {
    // The files landed under the other id: put back what that id had.
    let message = `${spec} holds ${id}, not ${expectedId}`;
    try {
      await settle(id, "rollback");
    } catch (settleError) {
      message += `; rollback failed (${errorText(settleError)})`;
    }
    throw new Error(message);
  }
  return queueEnablement(async () => {
    const reason: Superseded | null = uninstalledSince(ticket)
      ? "uninstalled"
      : isLatest()
        ? null
        : "newer";
    if (reason) {
      await discardDownload(id, reason);
      throw new InstallSupersededError(manifest, reason);
    }
    return swapIn(manifest, enable);
  });
}

/** Put a downloaded version live in place of the running one, rolling back to
 *  the previous version when it fails to start. */
async function swapIn(manifest: ExtensionManifest, enable: boolean): Promise<ExtensionManifest> {
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
 *  publishes no releases), or the release `version` when given. `enable: false`
 *  keeps a disabled id disabled: the files land, the extension stays off. */
export const installFromGitHub = (
  spec: string,
  version?: string,
  options: { enable?: boolean } = {},
): Promise<ExtensionManifest> => installAndActivate(spec, options.enable ?? true, version);

/** Reinstall an installed extension at `version` (the one its update check
 *  offered), keeping its settings and its enabled/disabled state. Updating
 *  stops keeping an older version. Given `id`, a download that holds another
 *  extension is rolled back instead of started. */
export async function updateExtension(
  fullName: string,
  version?: string,
  id?: string,
): Promise<ExtensionManifest> {
  const manifest = await installAndActivate(fullName, false, version, id);
  setKept(manifest.id, null);
  return manifest;
}

/** Stop and delete an installed extension, after any change already under way:
 *  a start of it still importing would otherwise go live once it is gone. */
export function uninstallPlugin(id: string): Promise<void> {
  uninstalledAt.set(id, ++changeRequests);
  return queueEnablement(async () => {
    teardown(id);
    // A dev-folder copy of the id, still running, keeps the settings it shares.
    if (!isInstanceLive(id)) deleteExtensionSettings(id); // forget its persisted settings too
    useExtStoreUI.getState().clearUpdate(id); // and its cached update check
    setKept(id, null); // and any version it was kept at
    forgetExtension(id); // and what it was seen doing, for saved layouts
    persistDisabled(useDisabledExtensions.getState().ids.filter((x) => x !== id));
    await privilegedPlugins()?.uninstall(id); // deletes <userData>/plugins/<id>/
  });
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
  const repo = updateRepoFor(manifest);
  if (!repo) {
    // Built-in, custom import with no known repo, or a remembered source that
    // disagrees with the manifest: nothing to offer, so drop any older offer.
    useExtStoreUI.getState().clearUpdate(manifest.id);
    return null;
  }
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
 *  (used by the periodic poll so it always re-checks). Checks run eight at a
 *  time, so the sweep finishes in roughly one round-trip. */
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
  await inPool(list, 8, async (m) => {
    const info = await checkExtensionUpdate(m, force);
    if (!settings.autoUpdateExtensions || !info || !autoInstallable(m, info)) return;
    const repo = updateRepoFor(m);
    if (!repo) return;
    try {
      await updateExtension(repo, info.latestTag ?? undefined, m.id);
    } catch (e) {
      console.error(`[extensions] auto-update failed for ${m.id}:`, e);
    }
  });
}

/** Run `task` over `items`, at most `limit` at a time. A worker pool rather than
 *  fixed batches: one slow item never holds up the rest. */
async function inPool<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export interface UpdateTarget {
  id: string;
  repo: string;
  version: string;
}

export interface UpdateAllResult {
  updated: ExtensionManifest[];
  failed: { id: string; error: string }[];
}

/** Update each target to the version its check offered, a few at a time. One
 *  failing doesn't stop the rest; `onSettled` fires as each one finishes. */
export async function updateExtensions(
  targets: readonly UpdateTarget[],
  onSettled?: (settled: number) => void,
): Promise<UpdateAllResult> {
  const result: UpdateAllResult = { updated: [], failed: [] };
  let settled = 0;
  await inPool(targets, 4, async (t) => {
    try {
      result.updated.push(await updateExtension(t.repo, t.version, t.id));
    } catch (e) {
      result.failed.push({ id: t.id, error: errorText(e) });
    }
    onSettled?.(++settled);
  });
  return result;
}
