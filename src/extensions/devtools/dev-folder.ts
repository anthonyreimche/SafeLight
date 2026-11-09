// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Dev-folder extension loading. Lets a developer point Safelight at a local
// folder of built extensions and load them live, without installing through
// GitHub. Owned entirely by the Developer Tools extension: the configured path
// lives in that extension's own settings, so disabling Developer Tools tears all
// of this down and the path is forgotten when it would be uninstalled.
//
// A dev folder mirrors the <userData>/plugins layout: each immediate subfolder
// is one extension with a safelight.json manifest and its built `main` bundle.
// Unlike installed plugins (served from app://__plugins__/), a dev folder is an
// arbitrary path, so we read the bundle bytes over the fs bridge and import them
// from a blob: URL (allowed by the renderer CSP's `script-src ... blob:`).
//
// Network access works as it does for an installed extension: the main process
// reads the folder's manifests at launch for their declared permissions.network
// origins (electron/extension-origins.cjs), so the folder is recorded with it
// (syncFolder) and a new declaration waits on a restart, which the Dev tab and
// Preferences ▸ Developer Tools say.

import { create } from "zustand";
import type { ExtensionManifest, ExtensionModule } from "../types";
import { DEVTOOLS_EXTENSION_ID, manifestIdRefusal } from "../official-extensions";
import { startInstance, stopInstances } from "../instance";
import { restoreDisplacedPlugins } from "../loader";
import { privilegedDevtools, privilegedFs } from "@/native/privileged";
import {
  getExtSetting,
  onExtSettingChange,
  setExtSetting,
} from "../ext-settings";

const FOLDER_KEY = "devFolder";

export type DevExtStatus = "loaded" | "error";

export interface DevExtItem {
  id: string;
  name: string;
  version: string;
  /** Absolute folder of this extension inside the dev folder. */
  dir: string;
  status: DevExtStatus;
  error?: string;
}

interface DevFolderState {
  folder: string | null;
  items: DevExtItem[];
  scanning: boolean;
  /** Folder-level error (e.g. the folder couldn't be listed). */
  error: string | null;
  /** Network origins the folder's manifests declare that the running app's
   *  policy does not allow: they take effect at the next launch. */
  pendingOrigins: string[];
}

export const useDevFolder = create<DevFolderState>(() => ({
  folder: getExtSetting<string | null>(DEVTOOLS_EXTENSION_ID, FOLDER_KEY, null),
  items: [],
  scanning: false,
  error: null,
  pendingOrigins: [],
}));

let started = false;
let unsubscribe: (() => void) | null = null;
// Bumped on every scan entry so a slow scan interrupted by a folder change (or
// Clear) bails instead of racing the newer scan's unloadAll.
let scanGen = 0;

/** Join two path segments using the separator the base path already uses, so a
 *  Windows backslash path stays consistent. */
function join(base: string, name: string): string {
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return base.replace(/[\\/]+$/, "") + sep + name;
}

function unloadAll(): void {
  stopInstances("dev");
}

/** Record the folder with the main process, which reads the manifests there at
 *  the next launch for their declared network origins — the path an installed
 *  extension's declaration takes — and learn which of those origins the
 *  running launch's policy still lacks. */
async function syncFolder(folder: string | null): Promise<void> {
  const bridge = privilegedDevtools();
  if (!bridge) return;
  try {
    const { pending } = await bridge.syncDevFolder(folder);
    // A folder chosen meanwhile has its own sync in flight.
    if (folder !== useDevFolder.getState().folder) return;
    useDevFolder.setState({ pendingOrigins: pending });
  } catch (e) {
    console.warn("[dev-folder] could not record the folder for the network policy:", e);
  }
}

/** Read + activate one extension folder. Throws on any failure (no manifest,
 *  bad JSON, a reserved or unofficial official-only id, missing bundle, no
 *  activate export, or not starting within the time guardExtension allows). */
async function loadOne(dir: string, manifestPath: string): Promise<DevExtItem> {
  const fs = privilegedFs();
  if (!fs) throw new Error("Loading extensions from a folder requires the desktop app.");
  const manifestBytes = await fs.read(manifestPath);
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestBytes.data),
  ) as ExtensionManifest;
  if (typeof manifest.id !== "string" || !manifest.id || !manifest.main)
    throw new Error("safelight.json is missing `id` or `main`");
  const refusal = manifestIdRefusal(manifest);
  if (refusal) {
    console.warn(`[dev-folder] refused ${refusal}`);
    throw new Error(refusal);
  }

  const { id } = manifest;
  const bundlePath = join(dir, manifest.main);
  await startInstance({
    id,
    source: "dev",
    name: manifest.name,
    bundle: bundlePath,
    read: async (signal) => {
      const bundle = await fs.read(bundlePath);
      signal.throwIfAborted();
      const blob = new Blob([bundle.data as BlobPart], { type: "text/javascript" });
      const url = URL.createObjectURL(blob);
      return {
        load: () => import(/* @vite-ignore */ url) as Promise<Partial<ExtensionModule>>,
        release: () => URL.revokeObjectURL(url),
      };
    },
  });
  return {
    id: manifest.id,
    name: manifest.name || manifest.id,
    version: manifest.version || "0.0.0",
    dir,
    status: "loaded",
  };
}

/** Unload everything, then re-read and load every extension in the dev folder.
 *  An installed extension a dev copy replaced starts again once the scan has
 *  left its id free. */
export async function scanDevFolder(): Promise<void> {
  const gen = ++scanGen;
  await loadFolder(gen);
  if (gen === scanGen) await restoreDisplacedPlugins();
}

async function loadFolder(gen: number): Promise<void> {
  const folder = useDevFolder.getState().folder;
  const fs = privilegedFs();
  void syncFolder(folder);
  unloadAll(); // always start from a clean slate
  if (!folder) {
    useDevFolder.setState({ items: [], scanning: false, error: null });
    return;
  }
  if (!fs) {
    useDevFolder.setState({
      items: [],
      scanning: false,
      error: "Loading extensions from a folder requires the desktop app.",
    });
    return;
  }

  useDevFolder.setState({ scanning: true, error: null });

  // The chosen folder can itself be one extension (its own safelight.json at the
  // root — the natural case when pointing at a single extension's repo), or a
  // parent whose immediate subfolders are each an extension (mirroring the
  // <userData>/plugins layout). Prefer the folder-is-an-extension reading: if a
  // root manifest exists, that's the developer's intent, so load just that one.
  const rootManifest = join(folder, "safelight.json");
  const hasRoot = await fs.exists(rootManifest).catch(() => false);
  if (gen !== scanGen) return;
  if (hasRoot) {
    const name = folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder;
    let item: DevExtItem;
    try {
      item = await loadOne(folder, rootManifest);
    } catch (e) {
      item = {
        id: name,
        name,
        version: "",
        dir: folder,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      };
    }
    if (gen !== scanGen) return;
    useDevFolder.setState({ items: [item], scanning: false, error: null });
    return;
  }

  let entries: { name: string; kind: "file" | "directory" }[];
  try {
    entries = await fs.list(folder);
  } catch (e) {
    if (gen !== scanGen) return;
    useDevFolder.setState({
      scanning: false,
      items: [],
      error: e instanceof Error ? e.message : String(e),
    });
    return;
  }

  const items: DevExtItem[] = [];
  for (const entry of entries) {
    if (gen !== scanGen) return;
    if (entry.kind !== "directory") continue;
    const dir = join(folder, entry.name);
    const manifestPath = join(dir, "safelight.json");
    // A subfolder without a manifest just isn't an extension — skip it quietly.
    if (!(await fs.exists(manifestPath).catch(() => false))) continue;
    try {
      items.push(await loadOne(dir, manifestPath));
    } catch (e) {
      items.push({
        id: entry.name,
        name: entry.name,
        version: "",
        dir,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  if (gen !== scanGen) return;
  useDevFolder.setState({ items, scanning: false, error: null });
}

/** Reload a single dev extension from disk (e.g. after rebuilding it). */
export async function reloadDevExtension(dir: string): Promise<void> {
  if (!privilegedFs()) return;
  const items = [...useDevFolder.getState().items];
  const idx = items.findIndex((i) => i.dir === dir);
  const prev = idx >= 0 ? items[idx] : undefined;
  let next: DevExtItem;
  try {
    next = await loadOne(dir, join(dir, "safelight.json"));
  } catch (e) {
    next = {
      id: prev?.id ?? dir,
      name: prev?.name ?? dir,
      version: "",
      dir,
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    };
  }
  if (idx >= 0) items[idx] = next;
  else items.push(next);
  useDevFolder.setState({ items });
  // A rebuilt manifest may declare a new origin.
  void syncFolder(useDevFolder.getState().folder);
  await restoreDisplacedPlugins();
}

/** Set (or clear with null) the dev folder. Persisted to the Developer Tools
 *  extension's settings; the change handler applies it and rescans, here and in
 *  any other open window. */
export function setDevFolder(path: string | null): void {
  setExtSetting(DEVTOOLS_EXTENSION_ID, FOLDER_KEY, path);
}

/** Open a native folder picker and adopt the chosen folder. */
export async function pickDevFolder(): Promise<void> {
  const fs = privilegedFs();
  if (!fs) return;
  const path = await fs.pickDirectory();
  if (path) setDevFolder(path);
}

/** Begin watching/scanning the dev folder. Called from the extension's
 *  activate(); safe to call repeatedly. */
export function initDevFolder(): void {
  if (started) return;
  started = true;
  const folder = getExtSetting<string | null>(DEVTOOLS_EXTENSION_ID, FOLDER_KEY, null);
  useDevFolder.setState({ folder });
  // Follow folder changes from Preferences / the Dev tab — including those made
  // in another window (ext-settings syncs via the storage event).
  unsubscribe = onExtSettingChange(DEVTOOLS_EXTENSION_ID, (key, value) => {
    if (key !== FOLDER_KEY) return;
    const nextFolder = (value as string | null) ?? null;
    if (nextFolder === useDevFolder.getState().folder) return;
    useDevFolder.setState({ folder: nextFolder });
    void scanDevFolder();
  });
  if (folder) void scanDevFolder();
  else void syncFolder(null);
}

/** Unload every dev extension and stop watching. Called from deactivate() when
 *  the Developer Tools extension is disabled. */
export function teardownDevFolder(): void {
  if (!started) return;
  started = false;
  unsubscribe?.();
  unsubscribe = null;
  unloadAll();
  void restoreDisplacedPlugins();
  useDevFolder.setState({ items: [], scanning: false, error: null, pendingOrigins: [] });
  // The folder's declarations leave the policy with the extensions themselves.
  void syncFolder(null);
}
