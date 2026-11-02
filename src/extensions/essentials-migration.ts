// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The one-time move from a built-in to the official extension that replaces
// it. A profile that has run a build with the built-ins gets the state kept
// under the old id renamed to the new one before the built-ins load, then the
// replacement installed once the installed extensions have loaded. A fresh
// profile is only recorded: the welcome setup installs the Essentials kit, and
// ensureCoreModules installs Library or Develop from the local official list
// when setup is over and the profile never had it (an offline first run).
// The record keeps the ids that are done, so a failed install is tried again
// on the next launch and a finished one is never repeated.

import { create } from "zustand";
import type { ExtensionManifest } from "./types";
import {
  OFFICIAL_EXTENSIONS,
  officialExtension,
  type OfficialExtension,
} from "./official-extensions";
import { isBuiltinExtension, isReservedExtensionId } from "./core-extension";
import { InstallSupersededError, installFromGitHub, useDisabledExtensions } from "./loader";
import { useUserLayouts, type UserLayout } from "./dock";
import { bannedReason } from "./trust";
import { rememberSource } from "./sources";
import { SETUP_INSTALL_TIMEOUT_MS } from "@/modules/welcome/setup/install-queue";
import { SETUP_RECORD_KEY, readSetupRecord } from "@/modules/welcome/setup/first-run";

export const MIGRATION_KEY = "sl_essentials_migration_v1";

const DISABLED_KEY = "sl_ext_disabled";
const SEEDED_KEY = "sl_ext_default_seeded";
const SETTINGS_PREFIX = "sl_ext_settings_";
const CORE_SETTINGS_KEY = "sl_settings_v1";
const KINDS_KEY = "sl_ext_kinds";
const USER_LAYOUTS_KEY = "sl_user_layouts";
const DOCK_LAYOUT_PREFIX = "sl_dock_layout_v4:";

export type MigrationStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;

/** The official extensions core no longer ships a built-in for: Library and
 *  Develop (core ships no module), and every row whose built-in is gone.
 *  `isBuiltin` says whether core still ships a built-in extension. */
export function extractedEssentials(
  rows: readonly OfficialExtension[] = OFFICIAL_EXTENSIONS,
  isBuiltin: (id: string) => boolean = isBuiltinExtension,
): OfficialExtension[] {
  return rows.filter((row) => row.replaces === null || !isBuiltin(row.replaces));
}

function readJson(storage: MigrationStorage, key: string): unknown {
  try {
    return JSON.parse(storage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

function writeJson(storage: MigrationStorage, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {}
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const stringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** The ids the record says are done, or null when there is no record. */
function readDone(storage: MigrationStorage): string[] | null {
  const record = readJson(storage, MIGRATION_KEY);
  return isRecord(record) ? stringList(record.done) : null;
}

function markDone(storage: MigrationStorage, ids: readonly string[]): void {
  const done = readDone(storage) ?? [];
  writeJson(storage, MIGRATION_KEY, {
    done: [...done, ...ids.filter((id) => !done.includes(id))],
  });
}

function storageKeys(storage: MigrationStorage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null) keys.push(key);
  }
  return keys;
}

/** "existing" for a profile that has run a build with the built-ins (or has
 *  the record already), "fresh" otherwise. Read before loadBuiltins, which
 *  writes one of the signs. */
export function classifyProfile(storage: MigrationStorage): "fresh" | "existing" {
  if (storage.getItem(MIGRATION_KEY) !== null) return "existing";
  if (storage.getItem(SEEDED_KEY) !== null) return "existing";
  if (storage.getItem(SETUP_RECORD_KEY) !== null) return "existing";
  const used = storageKeys(storage).some(
    (key) =>
      key.startsWith(DOCK_LAYOUT_PREFIX) ||
      (key.startsWith(SETTINGS_PREFIX) &&
        isReservedExtensionId(key.slice(SETTINGS_PREFIX.length))),
  );
  return used ? "existing" : "fresh";
}

function renameDisabled(storage: MigrationStorage, from: string, to: string): void {
  const ids = stringList(readJson(storage, DISABLED_KEY));
  if (!ids.includes(from)) return;
  const renamed = ids.includes(to)
    ? ids.filter((id) => id !== from)
    : ids.map((id) => (id === from ? to : id));
  writeJson(storage, DISABLED_KEY, renamed);
}

function moveSettings(storage: MigrationStorage, from: string, to: string): void {
  const old = storage.getItem(SETTINGS_PREFIX + from);
  if (old === null || storage.getItem(SETTINGS_PREFIX + to) !== null) return;
  try {
    storage.setItem(SETTINGS_PREFIX + to, old);
    storage.removeItem(SETTINGS_PREFIX + from);
  } catch {}
}

function renameLayoutTicks(storage: MigrationStorage, from: string, to: string): void {
  const layouts = readJson(storage, USER_LAYOUTS_KEY);
  if (!isRecord(layouts)) return;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, layout] of Object.entries(layouts)) {
    const ticks = isRecord(layout) ? layout.extensions : undefined;
    if (!isRecord(layout) || !isRecord(ticks) || !Object.hasOwn(ticks, from)) {
      next[key] = layout;
      continue;
    }
    const { [from]: tick, ...rest } = ticks;
    next[key] = { ...layout, extensions: Object.hasOwn(rest, to) ? rest : { ...rest, [to]: tick } };
    changed = true;
  }
  if (changed) writeJson(storage, USER_LAYOUTS_KEY, next);
}

function renameKind(storage: MigrationStorage, from: string, to: string): void {
  const kinds = readJson(storage, KINDS_KEY);
  if (!isRecord(kinds) || !Object.hasOwn(kinds, from)) return;
  const { [from]: old, ...rest } = kinds;
  const kind = old === "pixels" || rest[to] === "pixels" ? "pixels" : (rest[to] ?? old);
  writeJson(storage, KINDS_KEY, { ...rest, [to]: kind });
}

/** Preferences core kept for a built-in in its own settings, which became the
 *  official extension's: core's key, then the extension's. */
const CORE_PREFERENCES_MOVED: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  "safelight.basic": [["basicDetailSliders", "detailSliders"]],
};

function movePreferences(storage: MigrationStorage, id: string): void {
  const moved = CORE_PREFERENCES_MOVED[id];
  const core = readJson(storage, CORE_SETTINGS_KEY);
  if (!moved || !isRecord(core)) return;
  const stored = readJson(storage, SETTINGS_PREFIX + id);
  const settings = isRecord(stored) ? stored : {};
  const carried = moved.filter(([from, to]) => core[from] !== undefined && !Object.hasOwn(settings, to));
  if (carried.length === 0) return;
  writeJson(storage, SETTINGS_PREFIX + id, {
    ...settings,
    ...Object.fromEntries(carried.map(([from, to]) => [to, core[from]])),
  });
}

/** Move what is kept under the built-in's id to the official extension's. */
function renameState(storage: MigrationStorage, row: OfficialExtension): void {
  const from = row.replaces;
  if (from === null) return;
  renameDisabled(storage, from, row.id);
  moveSettings(storage, from, row.id);
  movePreferences(storage, row.id);
  renameLayoutTicks(storage, from, row.id);
  renameKind(storage, from, row.id);
}

const isDisabledIn = (storage: MigrationStorage, id: string): boolean =>
  stringList(readJson(storage, DISABLED_KEY)).includes(id);

/** Record a fresh profile, or rename an existing one's state for each
 *  extracted row not done yet. Answers the rows left to install. A row that is
 *  not an essential (Developer Tools) is installed only for a profile that had
 *  its built-in on; when it was off, it is done as it is. */
export function prepareEssentialsMigration(
  storage: MigrationStorage,
  extracted: readonly OfficialExtension[],
): OfficialExtension[] {
  if (classifyProfile(storage) === "fresh") {
    markDone(storage, extracted.map((r) => r.id));
    return [];
  }
  const done = readDone(storage) ?? [];
  const pending: OfficialExtension[] = [];
  const skipped: string[] = [];
  for (const row of extracted) {
    if (done.includes(row.id)) continue;
    renameState(storage, row);
    if (!row.essential && isDisabledIn(storage, row.id)) skipped.push(row.id);
    else pending.push(row);
  }
  markDone(storage, skipped);
  return pending;
}

function readUserLayouts(): Record<string, UserLayout> {
  const layouts = readJson(localStorage, USER_LAYOUTS_KEY);
  return isRecord(layouts) ? (layouts as Record<string, UserLayout>) : {};
}

/** prepareEssentialsMigration on this profile, before loadBuiltins. The
 *  disabled list and the saved layouts were read into memory as their modules
 *  loaded, so they are read again when the renames changed them. Main window
 *  only. */
export function startEssentialsMigration(
  extracted: readonly OfficialExtension[] = extractedEssentials(),
): OfficialExtension[] {
  const disabled = localStorage.getItem(DISABLED_KEY);
  const layouts = localStorage.getItem(USER_LAYOUTS_KEY);
  const pending = prepareEssentialsMigration(localStorage, extracted);
  if (localStorage.getItem(DISABLED_KEY) !== disabled)
    useDisabledExtensions.setState({ ids: stringList(readJson(localStorage, DISABLED_KEY)) });
  if (localStorage.getItem(USER_LAYOUTS_KEY) !== layouts)
    useUserLayouts.setState({ layouts: readUserLayouts() });
  return pending;
}

// ─── Installing ──────────────────────────────────────────────────────────────

export interface EssentialsMigrationState {
  status: "idle" | "installing" | "failed";
  /** The ids still to install: during a run, those not reached yet. */
  missing: string[];
}

export const useEssentialsMigration = create<EssentialsMigrationState>(() => ({
  status: "idle",
  missing: [],
}));

export interface EssentialsInstallDeps {
  storage: MigrationStorage;
  /** The ids of the extensions installed now, enabled or not. */
  installedIds(): Promise<string[]>;
  install(repo: string, enable: boolean): Promise<ExtensionManifest>;
  bannedReason(repo: string): string | null;
  rememberSource(id: string, repo: string): void;
  timeoutMs: number;
}

async function nativeInstalledIds(): Promise<string[]> {
  const native = window.safelightNative;
  if (!native) throw new Error("no native bridge");
  return (await native.plugins.list()).map((m) => m.id);
}

const liveDeps = (): EssentialsInstallDeps => ({
  storage: localStorage,
  installedIds: nativeInstalledIds,
  install: (repo, enable) => installFromGitHub(repo, undefined, { enable }),
  bannedReason,
  rememberSource,
  timeoutMs: SETUP_INSTALL_TIMEOUT_MS,
});

const TIMED_OUT = Symbol("timed out");

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

function settleMissing(id: string): void {
  useEssentialsMigration.setState((s) => {
    const missing = s.missing.filter((x) => x !== id);
    return { missing, status: s.status === "failed" && missing.length === 0 ? "idle" : s.status };
  });
}

/** Install one row, marking it done the moment it lands, however late that is.
 *  Answers whether it landed in time. */
async function installRow(row: OfficialExtension, deps: EssentialsInstallDeps): Promise<boolean> {
  const banned = deps.bannedReason(row.repo);
  if (banned) {
    console.warn(`[essentials] not installing ${row.id}: ${banned}`);
    return false;
  }
  const work = deps.install(row.repo, !isDisabledIn(deps.storage, row.id));
  const settled = () => {
    markDone(deps.storage, [row.id]);
    markCoreModulesInstalled(deps.storage, [row.id]);
    settleMissing(row.id);
  };
  // Uninstalled while it downloaded: the person removed it, so it is not missing.
  const removed = (e: unknown) => e instanceof InstallSupersededError && e.reason === "uninstalled";
  work.then(
    (m) => {
      deps.rememberSource(m.id, row.repo);
      settled();
    },
    (e: unknown) => {
      if (removed(e)) settled();
    },
  );
  try {
    return (await withDeadline(work, deps.timeoutMs)) !== TIMED_OUT;
  } catch (e) {
    if (removed(e)) return true;
    console.warn(`[essentials] could not install ${row.id}:`, e);
    return false;
  }
}

let running: Promise<void> | null = null;

async function runInstalls(
  rows: readonly OfficialExtension[],
  deps: EssentialsInstallDeps,
): Promise<void> {
  const installed = new Set(await deps.installedIds().catch(() => []));
  const already = rows.filter((r) => installed.has(r.id)).map((r) => r.id);
  markDone(deps.storage, already);
  const queue = rows.filter((r) => !installed.has(r.id));
  if (queue.length === 0) {
    useEssentialsMigration.setState({ status: "idle", missing: [] });
    return;
  }
  useEssentialsMigration.setState({ status: "installing", missing: queue.map((r) => r.id) });
  const failed: string[] = [];
  for (const row of queue) if (!(await installRow(row, deps))) failed.push(row.id);
  const missing = failed.filter((id) => !(readDone(deps.storage) ?? []).includes(id));
  useEssentialsMigration.setState({ status: missing.length > 0 ? "failed" : "idle", missing });
}

/** Install `rows` one at a time through the loader, after the installed
 *  extensions have loaded. An essential the person had disabled installs
 *  disabled. A run already under way is joined rather than repeated. */
export function installEssentials(
  rows: readonly OfficialExtension[],
  deps: EssentialsInstallDeps = liveDeps(),
): Promise<void> {
  if (running) return running;
  const run = runInstalls(rows, deps).finally(() => {
    running = null;
  });
  running = run;
  return run;
}

/** Try the essentials that failed to install again. */
export function retryEssentials(deps: EssentialsInstallDeps = liveDeps()): Promise<void> {
  const rows = useEssentialsMigration
    .getState()
    .missing.map(officialExtension)
    .filter((r): r is OfficialExtension => r !== undefined);
  return installEssentials(rows, deps);
}

// ─── Core modules ────────────────────────────────────────────────────────────

/** Library and Develop are the two modules; with neither there is no app. */
const CORE_MODULE_IDS = ["safelight.library", "safelight.develop"];

/** The modules this profile has had installed. One missing after that was
 *  uninstalled by the person, so it is not installed again. */
const CORE_INSTALLED_KEY = "sl_core_modules_installed";

function markCoreModulesInstalled(storage: MigrationStorage, ids: readonly string[]): void {
  const had = stringList(readJson(storage, CORE_INSTALLED_KEY));
  const added = ids.filter((id) => CORE_MODULE_IDS.includes(id) && !had.includes(id));
  if (added.length > 0) writeJson(storage, CORE_INSTALLED_KEY, [...had, ...added]);
}

let stopOnlineRetry: (() => void) | null = null;

/** One more try when the connection comes back, for a first run that began
 *  offline. A later run replaces the wait; a retry that fails is not repeated
 *  (the notice's Retry is still there). A run under way is waited for, since
 *  retrying would only join it. */
function retryOnceOnline(deps: EssentialsInstallDeps): void {
  stopOnlineRetry?.();
  const onOnline = () => {
    stopOnlineRetry = null;
    void (running ?? Promise.resolve()).then(() => retryEssentials(deps));
  };
  window.addEventListener("online", onOnline, { once: true });
  stopOnlineRetry = () => window.removeEventListener("online", onOnline);
}

async function installAndWatch(
  rows: readonly OfficialExtension[],
  deps: EssentialsInstallDeps,
): Promise<void> {
  await installEssentials(rows, deps);
  if (useEssentialsMigration.getState().status === "failed") retryOnceOnline(deps);
}

/** Install the Essentials from the official list this build carries, which
 *  needs no registry fetch. What is installed already is skipped. */
export function installMissingEssentials(deps: EssentialsInstallDeps = liveDeps()): Promise<void> {
  return installAndWatch(
    extractedEssentials().filter((r) => r.essential),
    deps,
  );
}

/** The modules not installed that this profile never had installed. */
async function coreModulesNeverInstalled(deps: EssentialsInstallDeps): Promise<OfficialExtension[]> {
  const ids = await deps.installedIds().catch(() => null);
  if (ids === null) return [];
  markCoreModulesInstalled(deps.storage, ids);
  const had = stringList(readJson(deps.storage, CORE_INSTALLED_KEY));
  return CORE_MODULE_IDS.filter((id) => !had.includes(id))
    .map(officialExtension)
    .filter((r): r is OfficialExtension => r !== undefined);
}

/** Run on every launch and when first-run setup closes. A profile whose setup
 *  is over but never had Library or Develop (it was offline, or the person
 *  skipped the Essentials) gets that module, along with `pending`, the rows the
 *  migration left. While setup is still to be offered or under way the setup
 *  installs them. */
export async function ensureCoreModules(
  pending: readonly OfficialExtension[] = [],
  deps: EssentialsInstallDeps = liveDeps(),
): Promise<void> {
  const record = readSetupRecord(deps.storage);
  const setupOver = record !== null && record.outcome !== "in-progress";
  const missing = await coreModulesNeverInstalled(deps);
  const core = setupOver ? missing : [];
  const rows = [...core, ...pending.filter((r) => !core.includes(r))];
  if (rows.length > 0) return installAndWatch(rows, deps);
}
