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

import { create } from "zustand";
import type { ExtensionManifest, ExtensionModule } from "../types";
import { makeScopedAPI } from "../host";
import { unregisterExtension } from "../registry";
import {
  getExtSetting,
  onExtSettingChange,
  setExtSetting,
} from "../ext-settings";

const DEVTOOLS_ID = "core.devtools";
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
}

export const useDevFolder = create<DevFolderState>(() => ({
  folder: getExtSetting<string | null>(DEVTOOLS_ID, FOLDER_KEY, null),
  items: [],
  scanning: false,
  error: null,
}));

// Live module instances + their blob URLs, keyed by extension id, so a rescan
// (or single reload) can tear down the previous load before re-activating.
const loaded = new Map<string, ExtensionModule>();
const blobUrls = new Map<string, string>();

let started = false;
let unsubscribe: (() => void) | null = null;

/** Join two path segments using the separator the base path already uses, so a
 *  Windows backslash path stays consistent. */
function join(base: string, name: string): string {
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return base.replace(/[\\/]+$/, "") + sep + name;
}

/** Tear down a single loaded dev extension and sweep its contributions. */
function unload(id: string): void {
  try {
    loaded.get(id)?.deactivate?.();
  } catch (e) {
    console.warn(`[dev-folder] ${id} deactivate threw:`, e);
  }
  loaded.delete(id);
  unregisterExtension(id);
  const url = blobUrls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    blobUrls.delete(id);
  }
}

function unloadAll(): void {
  for (const id of [...loaded.keys()]) unload(id);
}

/** Read + activate one extension folder. Throws on any failure (no manifest,
 *  bad JSON, missing bundle, no activate export). */
async function loadOne(dir: string, manifestPath: string): Promise<DevExtItem> {
  const native = window.safelightNative!;
  const manifestBytes = await native.fs!.read(manifestPath);
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestBytes.data),
  ) as ExtensionManifest;
  if (!manifest.id || !manifest.main)
    throw new Error("safelight.json is missing `id` or `main`");

  // Replace any prior live instance of this id (a previous dev load).
  if (loaded.has(manifest.id)) unload(manifest.id);

  const bundle = await native.fs!.read(join(dir, manifest.main));
  const blob = new Blob([bundle.data as BlobPart], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  let mod: Partial<ExtensionModule>;
  try {
    mod = (await import(/* @vite-ignore */ url)) as Partial<ExtensionModule>;
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  if (typeof mod.activate !== "function") {
    URL.revokeObjectURL(url);
    throw new Error("bundle has no activate(api) export");
  }
  mod.activate(makeScopedAPI(manifest.id));
  loaded.set(manifest.id, mod as ExtensionModule);
  blobUrls.set(manifest.id, url);
  return {
    id: manifest.id,
    name: manifest.name || manifest.id,
    version: manifest.version || "0.0.0",
    dir,
    status: "loaded",
  };
}

/** Unload everything, then re-read and load every extension in the dev folder. */
export async function scanDevFolder(): Promise<void> {
  const folder = useDevFolder.getState().folder;
  const native = window.safelightNative;
  unloadAll(); // always start from a clean slate
  if (!folder) {
    useDevFolder.setState({ items: [], scanning: false, error: null });
    return;
  }
  if (!native?.fs) {
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
  if (await native.fs.exists(rootManifest).catch(() => false)) {
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
    useDevFolder.setState({ items: [item], scanning: false, error: null });
    return;
  }

  let entries: { name: string; kind: "file" | "directory" }[];
  try {
    entries = await native.fs.list(folder);
  } catch (e) {
    useDevFolder.setState({
      scanning: false,
      items: [],
      error: e instanceof Error ? e.message : String(e),
    });
    return;
  }

  const items: DevExtItem[] = [];
  for (const entry of entries) {
    if (entry.kind !== "directory") continue;
    const dir = join(folder, entry.name);
    const manifestPath = join(dir, "safelight.json");
    // A subfolder without a manifest just isn't an extension — skip it quietly.
    if (!(await native.fs.exists(manifestPath).catch(() => false))) continue;
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
  useDevFolder.setState({ items, scanning: false, error: null });
}

/** Reload a single dev extension from disk (e.g. after rebuilding it). */
export async function reloadDevExtension(dir: string): Promise<void> {
  const native = window.safelightNative;
  if (!native?.fs) return;
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
}

/** Set (or clear with null) the dev folder. Persisted to the Developer Tools
 *  extension's settings; the change handler applies it and rescans, here and in
 *  any other open window. */
export function setDevFolder(path: string | null): void {
  setExtSetting(DEVTOOLS_ID, FOLDER_KEY, path);
}

/** Open a native folder picker and adopt the chosen folder. */
export async function pickDevFolder(): Promise<void> {
  const native = window.safelightNative;
  if (!native?.fs) return;
  const path = await native.fs.pickDirectory();
  if (path) setDevFolder(path);
}

/** Begin watching/scanning the dev folder. Called from the extension's
 *  activate(); safe to call repeatedly. */
export function initDevFolder(): void {
  if (started) return;
  started = true;
  const folder = getExtSetting<string | null>(DEVTOOLS_ID, FOLDER_KEY, null);
  useDevFolder.setState({ folder });
  // Follow folder changes from Preferences / the Dev tab — including those made
  // in another window (ext-settings syncs via the storage event).
  unsubscribe = onExtSettingChange(DEVTOOLS_ID, (key, value) => {
    if (key !== FOLDER_KEY) return;
    const nextFolder = (value as string | null) ?? null;
    if (nextFolder === useDevFolder.getState().folder) return;
    useDevFolder.setState({ folder: nextFolder });
    void scanDevFolder();
  });
  if (folder) void scanDevFolder();
}

/** Unload every dev extension and stop watching. Called from deactivate() when
 *  the Developer Tools extension is disabled. */
export function teardownDevFolder(): void {
  if (!started) return;
  started = false;
  unsubscribe?.();
  unsubscribe = null;
  unloadAll();
  useDevFolder.setState({ items: [], scanning: false, error: null });
}
