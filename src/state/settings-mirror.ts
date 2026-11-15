// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Keeps <userData>/shared-settings.json in step with the settings `slu` and the
// engine need from this profile's localStorage, which neither can read. The
// main window sends it at start, half a second after a mirrored setting
// changes, and every minute. The main process rewrites the file only when it
// changed, and marks each send in a small heartbeat file, which `slu` reads as
// the app being open (electron/extension-state.cjs).

import { GUI_HEARTBEAT_MS, MIRRORED_STORAGE_KEYS } from "./shared-settings";
import { useSettings } from "./settings-store";
import { usePresetsStore } from "./presets-store";
import { useExtSettings } from "@/extensions/ext-settings";
import { usePipelineStore } from "@/extensions/pipelines";
import { onInputProfilesChanged } from "@/catalog/input-profiles";
import { listRecentProjects } from "@/project/recent";
import { windowRole } from "@/diagnostics/environment";
import { privilegedMirror } from "@/native/privileged";

const DEBOUNCE_MS = 500;

function isMirrored(key: string): boolean {
  return MIRRORED_STORAGE_KEYS.some((k) => (k.endsWith("*") ? key.startsWith(k.slice(0, -1)) : key === k));
}

function mirroredStorage(): Record<string, string> {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key !== null && isMirrored(key)) keys.push(key);
  }
  const storage: Record<string, string> = {};
  for (const key of keys.sort()) {
    const value = localStorage.getItem(key);
    if (value !== null) storage[key] = value;
  }
  return storage;
}

/** Start mirroring, in the main window only: the engine's page reports itself
 *  as the main window too, and its settings are the copy, not the source.
 *  Returns the stop. A failed write is logged once and retried at the next
 *  change or heartbeat; it never reaches the caller. */
export function initSettingsMirror(): () => void {
  if (windowRole() !== "main" || location.pathname.endsWith("/engine.html")) return () => {};
  const bridge = privilegedMirror();
  const writeDoc = bridge?.writeSharedSettings?.bind(bridge);
  if (!writeDoc) return () => {};

  let written: string | null = null;
  let warned = false;
  let queue: Promise<void> = Promise.resolve();
  const write = (always: boolean) => {
    queue = queue
      .then(async () => {
        const storage = mirroredStorage();
        const serialized = JSON.stringify(storage);
        if (!always && serialized === written) return;
        const recent = await listRecentProjects();
        await writeDoc({
          version: 1,
          appVersion: __APP_VERSION__,
          writtenAt: Date.now(),
          guiPid: null,
          recentProjects: recent.flatMap((p) => (p.path ? [p.path] : [])),
          storage,
        });
        written = serialized;
        warned = false;
      })
      .catch((e: unknown) => {
        if (!warned) console.warn("[settings] could not share settings with slu:", e);
        warned = true;
      });
  };

  let pending: ReturnType<typeof setTimeout> | null = null;
  const changed = () => {
    if (pending !== null) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      write(false);
    }, DEBOUNCE_MS);
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || isMirrored(e.key)) changed();
  };

  const unsubscribes = [
    useSettings.subscribe(changed),
    usePresetsStore.subscribe(changed),
    useExtSettings.subscribe(changed),
    usePipelineStore.subscribe(changed),
    onInputProfilesChanged(changed),
  ];
  window.addEventListener("storage", onStorage);
  const heartbeat = setInterval(() => write(true), GUI_HEARTBEAT_MS);
  write(true);

  return () => {
    if (pending !== null) clearTimeout(pending);
    clearInterval(heartbeat);
    window.removeEventListener("storage", onStorage);
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
