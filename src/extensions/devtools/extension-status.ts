// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// api.devtools.extensions: every extension this window knows of, joined from
// what is running, what is installed (read from the main process, since the
// launch pass's list goes stale on an install, update or uninstall), the turned
// off list, the failure records and the dev folder.

import { useSyncExternalStore } from "react";
import type { DevExtensionInfo, DevtoolsExtensions } from "../api/devtools";
import type { ExtensionManifest } from "../types";
import { useCallbackFailures } from "../guard";
import { useDisabledExtensions, useInstalledPlugins } from "../loader";
import { useRunningPlugins, type RunningInstance } from "../running-plugins";
import { useStartFailures } from "../start-failures";
import { reloadDevExtension, useDevFolder } from "./dev-folder";

type Identity = Pick<DevExtensionInfo, "id" | "name" | "version" | "source">;

const listeners = new Set<() => void>();
let unwire: (() => void) | null = null;
let manifests: readonly ExtensionManifest[] = [];
let manifestsRequested = false;
let refreshGen = 0;
let cached: readonly DevExtensionInfo[] = [];

function join(): DevExtensionInfo[] {
  const { instances } = useRunningPlugins.getState();
  const disabled = new Set(useDisabledExtensions.getState().ids);
  const startFailures = useStartFailures.getState();
  const callbackFailures = useCallbackFailures.getState();
  const devItems = useDevFolder.getState().items;

  const instance = (id: string, source: RunningInstance["source"]) =>
    instances.find((i) => i.id === id && i.source === source);
  const info = (who: Identity, devError: string | null): DevExtensionInfo => ({
    ...who,
    running: instance(who.id, who.source) !== undefined,
    enabled: !disabled.has(who.id),
    failure: startFailures[who.id] ?? null,
    callbackFailures: who.id in callbackFailures ? 1 : 0,
    devError,
  });
  const identity = (i: RunningInstance): Identity => ({ id: i.id, name: i.name, version: i.version, source: i.source });

  const devIds = new Set([...devItems.map((i) => i.id), ...instances.filter((i) => i.source === "dev").map((i) => i.id)]);
  const installed: Identity[] = manifests
    .filter((m) => !devIds.has(m.id))
    .map((m) => {
      const live = instance(m.id, "installed");
      return live ? identity(live) : { id: m.id, name: m.name, version: m.version, source: "installed" };
    });
  for (const live of instances)
    if (live.source === "installed" && !installed.some((i) => i.id === live.id)) installed.push(identity(live));

  const dev = devItems.map((item) => {
    const live = instance(item.id, "dev");
    return info(live ? identity(live) : { id: item.id, name: item.name, version: item.version, source: "dev" }, item.error ?? null);
  });
  for (const live of instances)
    if (live.source === "dev" && !devItems.some((i) => i.id === live.id)) dev.push(info(identity(live), null));

  return [
    ...instances.filter((i) => i.source === "builtin").map((i) => info(identity(i), null)),
    ...installed.map((who) => info(who, null)),
    ...dev,
  ];
}

/** Rebuild the list; true when it differs from the last. A read doesn't tell
 *  the listeners, which may be React asking mid-render. */
function rebuild(): boolean {
  const next = join();
  if (JSON.stringify(next) === JSON.stringify(cached)) return false;
  cached = next;
  return true;
}

function recompute(): void {
  if (rebuild()) for (const listener of [...listeners]) listener();
}

function refreshManifests(): void {
  manifestsRequested = true;
  const native = window.safelightNative;
  if (!native) return;
  const gen = ++refreshGen;
  native.plugins.list().then(
    (list) => {
      if (gen !== refreshGen) return;
      manifests = list;
      recompute();
    },
    (e: unknown) => console.warn("[devtools] could not list the installed extensions:", e),
  );
}

// The installed list only changes on an install, update or uninstall, but the
// stores that tell of one tick for every extension started at launch and every
// dev-folder scan: one read of the list follows a burst of them.
const REFRESH_DELAY_MS = 250;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function onInputsChanged(): void {
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshManifests();
  }, REFRESH_DELAY_MS);
  recompute();
}

function wire(): () => void {
  const stops = [
    useRunningPlugins.subscribe(onInputsChanged),
    useDisabledExtensions.subscribe(onInputsChanged),
    useInstalledPlugins.subscribe(onInputsChanged),
    useDevFolder.subscribe(onInputsChanged),
    useStartFailures.subscribe(recompute),
    useCallbackFailures.subscribe(recompute),
  ];
  refreshManifests();
  rebuild();
  return () => {
    stops.forEach((stop) => stop());
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = null;
  };
}

/** While anything listens, the list is kept current as its inputs change, so a
 *  read (React's, on every render) costs nothing. */
function get(): readonly DevExtensionInfo[] {
  if (unwire) return cached;
  if (!manifestsRequested) refreshManifests();
  rebuild();
  return cached;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  unwire ??= wire();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    unwire?.();
    unwire = null;
  };
}

export const devtoolsExtensions: DevtoolsExtensions = {
  get,
  subscribe,
  use: () => useSyncExternalStore(subscribe, get, get),
  async reloadDev(id) {
    const item = useDevFolder.getState().items.find((i) => i.id === id);
    if (item) await reloadDevExtension(item.dir);
  },
};
