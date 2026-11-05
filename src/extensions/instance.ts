// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The one answer to "which copy of extension X is running in this window". A
// built-in is activated from the app's own list; an installed extension and a
// dev-folder one are imported from a bundle. Either kind of bundle goes through
// the same sequence here: import, activate under the guard, record, and later
// deactivate and sweep. The loader and the dev-folder loader choose what to
// start and where its bundle comes from; neither keeps a list of its own.

import type { ExtensionModule, SafelightAPI } from "./types";
import { unregisterExtension } from "./registry";
import { setExtensionName } from "./param-registry";
import { BUILTIN_EXTENSIONS, type BuiltinExtension } from "./builtin";
import { noteExtensionRunning } from "./extension-kinds";
import { activateFenced, createLoadTracker } from "./guard";
import { useRunningPlugins } from "./running-plugins";
import { forgetStartFailure, recordStartFailure } from "./start-failures";

let scopedAPI: ((id: string) => SafelightAPI) | null = null;

/** The host hands over the maker of each extension's API as it loads, so this
 *  module, which the host's own imports reach, never imports the host back. */
export function provideScopedAPI(make: (id: string) => SafelightAPI): void {
  scopedAPI = make;
}

function makeScopedAPI(id: string): SafelightAPI {
  if (!scopedAPI) throw new Error(`${id}: the extension host has not loaded`);
  return scopedAPI(id);
}

/** The built-in extension `id` names, if it is one. core-extension.ts keeps the
 *  ids alone, for the modules that can't import this list. */
export const builtinExtension = (id: string): BuiltinExtension | undefined =>
  BUILTIN_EXTENSIONS.find((b) => b.id === id);

/** Call an extension's deactivate. One that throws is logged, so stopping it,
 *  and an update's swap or rollback after that, still go ahead. */
export function deactivateGuarded(id: string, deactivate: () => void): void {
  try {
    deactivate();
  } catch (e) {
    console.warn(`[extensions] ${id} deactivate threw:`, e);
  }
}

// ─── Built-ins ──────────────────────────────────────────────────────────────

// A built-in's activate() isn't safe to run twice, so turning on one that is
// already running leaves it alone.
const activeBuiltins = new Set<string>();

export const isBuiltinActive = (id: string): boolean => activeBuiltins.has(id);

/** Start a built-in. One that throws is swept and logged like an installed
 *  extension that fails to start, so the built-ins after it and the rest of
 *  boot go ahead. */
export function startBuiltin(ext: BuiltinExtension): void {
  try {
    ext.activate(makeScopedAPI(ext.id));
  } catch (e) {
    unregisterExtension(ext.id);
    recordStartFailure(ext.id, e);
    console.error(`[extensions] failed to start ${ext.id}:`, e);
    return;
  }
  forgetStartFailure(ext.id);
  activeBuiltins.add(ext.id);
  noteExtensionRunning(ext.id);
}

/** Stop a built-in, tearing down side effects (e.g. console patches), and sweep
 *  its contributions. */
export function stopBuiltin(ext: BuiltinExtension): void {
  if (activeBuiltins.delete(ext.id)) deactivateGuarded(ext.id, () => ext.deactivate?.());
  unregisterExtension(ext.id);
}

// ─── Bundles ────────────────────────────────────────────────────────────────

/** Where a running extension came from: installed under the plugins folder, or
 *  loaded from the developer's folder. */
export type InstanceSource = "installed" | "dev";

interface Started {
  mod: ExtensionModule;
  /** Frees what the bundle was imported from, once it stops. */
  release?: () => void;
  /** What this activation subscribed to, to drop if it ends up stopped late. */
  subscriptions: Set<() => void>;
}

interface Live extends Started {
  source: InstanceSource;
}

/** A bundle read and ready to import. */
export interface BundleRead {
  load(): Promise<Partial<ExtensionModule>>;
  release?(): void;
}

export interface InstanceStart {
  id: string;
  source: InstanceSource;
  /** Shown as the extension's name wherever its contributions are listed. */
  name?: string;
  /** Names the bundle, so a start of the same bundle joins the one under way and
   *  one of another takes the id over (see createLoadTracker). */
  bundle: string;
  read(signal: AbortSignal): Promise<BundleRead>;
  /** Asked once the bundle has imported, before it activates: false drops the
   *  start quietly, as for an extension turned off while its bundle was on the
   *  way. */
  stillWanted?(): boolean;
}

/** A start dropped because it was no longer wanted: nothing to report. */
class DroppedStart extends Error {}

const live = new Map<string, Live>();
// Installed extensions a dev-folder copy of the same id stopped, to start again
// once nothing holds the id.
const displaced = new Set<string>();
const loadTracked = createLoadTracker<Started>();

function publishRunning(): void {
  useRunningPlugins.setState({ ids: [...live.keys()] });
}

/** Whether a bundle-loaded extension is running as `id`, from `source` when
 *  given, from either otherwise. */
export const isInstanceLive = (id: string, source?: InstanceSource): boolean => {
  const instance = live.get(id);
  return !!instance && (source === undefined || instance.source === source);
};

/** The installed extensions a dev-folder copy stopped whose ids are free again,
 *  forgotten as they are handed over. */
export function takeDisplaced(): string[] {
  const free = [...displaced].filter((id) => !live.has(id));
  for (const id of free) displaced.delete(id);
  return free;
}

/** Import, activate and record an extension. Rejects when it can't start, with
 *  whatever it registered before failing swept. */
export async function startInstance(start: InstanceStart): Promise<void> {
  const { id, source } = start;
  if (source === "dev") {
    // The developer's copy takes the id over; an installed one it stops is
    // started again when the dev copy unloads.
    if (isInstanceLive(id, "installed")) displaced.add(id);
    if (isInstanceLive(id)) stopInstance(id);
  }
  let started: Started;
  try {
    started = await loadTracked(
      id,
      start.bundle,
      async (signal) => {
        const { load, release } = await start.read(signal);
        const subscriptions = new Set<() => void>();
        try {
          const imported = await load();
          if (start.stillWanted && !start.stillWanted()) throw new DroppedStart(`${id}: no longer wanted`);
          if (typeof imported.activate !== "function")
            throw new Error(`${id}: bundle has no activate(api) export`);
          const mod = imported as ExtensionModule;
          signal.throwIfAborted();
          if (start.name) setExtensionName(id, start.name);
          await activateFenced(mod, makeScopedAPI(id), signal, subscriptions);
          return { mod, release, subscriptions };
        } catch (e) {
          if (signal.aborted) subscriptions.forEach((unsubscribe) => unsubscribe());
          release?.();
          throw e;
        }
      },
      {
        sweep: () => unregisterExtension(id), // whatever it registered before it failed
        stop: (late) => {
          deactivateGuarded(id, () => late.mod.deactivate?.());
          late.subscriptions.forEach((unsubscribe) => unsubscribe());
          late.release?.();
        },
      },
    );
  } catch (e) {
    if (e instanceof DroppedStart) return;
    // A start overtaken by one that has since gone live has nothing to report.
    if (!live.has(id)) recordStartFailure(id, e);
    throw e;
  }
  forgetStartFailure(id);
  live.set(id, { ...started, source });
  publishRunning();
}

function unsubscribeGuarded(unsubscribe: () => void): void {
  try {
    unsubscribe();
  } catch {
    // One extension's faulty unsubscribe must not keep the rest listening.
  }
}

/** Stop a running bundle-loaded extension and sweep its contributions. Given
 *  `only`, a copy that came from another source is left running. */
export function stopInstance(id: string, only?: InstanceSource): void {
  const instance = live.get(id);
  if (instance && only !== undefined && instance.source !== only) return;
  deactivateGuarded(id, () => instance?.mod.deactivate?.());
  if (live.delete(id)) publishRunning();
  unregisterExtension(id);
  instance?.subscriptions.forEach(unsubscribeGuarded);
  instance?.subscriptions.clear();
  instance?.release?.();
}

/** Stop every running extension that came from `source`. */
export function stopInstances(source: InstanceSource): void {
  for (const [id, instance] of [...live])
    if (instance.source === source) stopInstance(id);
}
