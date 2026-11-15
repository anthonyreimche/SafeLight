// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Changes to a project's catalogue made outside this process: another
// `safelight` command, or the app. The folder is watched rather than the file,
// since a save may replace the file and a watch on it would end there.

import { watch as watchFolder } from "node:fs";

const CATALOG_FILE = "catalog.json";
const DEBOUNCE_MS = 150;

/** Calls `onEvent` with the name of each file that changed in `dir` (null when the platform doesn't say). */
export type Watch = (dir: string, onEvent: (file: string | null) => void) => { close(): void };

const nodeWatch: Watch = (dir, onEvent) => {
  const watcher = watchFolder(dir, (_event, file) => onEvent(file === null ? null : String(file)));
  // A folder that goes away, or a platform that can't watch, leaves the view as it is.
  watcher.on("error", () => {});
  return watcher;
};

/** Calls `onChange` once a burst of changes to the catalogue in `workingDir` has settled. Returns the stop. */
export function watchCatalogue(
  workingDir: string,
  onChange: () => void,
  options: { debounceMs?: number; watch?: Watch } = {},
): () => void {
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let watcher: { close(): void } | null = null;
  try {
    watcher = (options.watch ?? nodeWatch)(workingDir, (file) => {
      if (stopped || (file !== null && file !== CATALOG_FILE)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (!stopped) onChange();
      }, debounceMs);
    });
  } catch {
    // No watch: in-process changes still show.
  }
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}
