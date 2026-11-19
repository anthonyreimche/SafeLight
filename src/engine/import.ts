// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// `slu import`: the GUI's folder open, run in the engine page as the
// catalogue's writer for this one request, holding the writer lock as `slu`.
// The walk, the records, the previews, sidecar adoption and the extensions'
// import hooks are the GUI's own code; so are the passes after it (the RAW
// camera data, missing previews), over the photos the import was asked for.

import type { CatalogPhoto } from "@/catalog/types";
import { setCatalogStorage } from "@/catalog/storage";
import { readPendingMetadata, repairMissingPreviews } from "@/modules/library/import-passes";
import { nativeDirectoryHandle, nativeFs, nativePathOf } from "@/project/native-fs";
import { ProjectStorage, type OpenedProject, type ProjectStorageDeps } from "@/project/project-storage";
import { storageDeps } from "@/project/storage-deps";
import { LockLostError, ProjectLockedError, type StorageOpenOptions } from "@/project/storage-options";
import { useCatalogStore, type RebuiltChange } from "@/state/catalog-store";
import type { EngineEvent, ImportScope } from "./protocol";
import { EngineFailure, type ImportRequest, type RequestOut } from "./rpc";

export interface ImportDeps {
  directory(root: string): FileSystemDirectoryHandle;
  open: typeof ProjectStorage.open;
  storageDeps: ProjectStorageDeps;
  readPendingMetadata: typeof readPendingMetadata;
  repairMissingPreviews: typeof repairMissingPreviews;
  /** A handle's absolute path, or null for one with none. */
  pathOf(handle: unknown): string | null;
  exists(path: string): Promise<boolean>;
}

const DEFAULT_DEPS: ImportDeps = {
  directory: nativeDirectoryHandle,
  open: ProjectStorage.open.bind(ProjectStorage),
  storageDeps,
  readPendingMetadata,
  repairMissingPreviews,
  pathOf: nativePathOf,
  exists: async (path) => (await nativeFs()?.exists(path)) ?? false,
};

type Stopped = Extract<EngineEvent, { type: "import-done" }>["stopped"];

const slashed = (path: string) => path.replace(/[/\\]+/g, "/").replace(/\/$/, "");

/** `path` as a path from `root`, or null when it isn't under it. */
function relativeTo(root: string, path: string): string | null {
  const base = `${slashed(root)}/`;
  const own = slashed(path);
  return own.toLowerCase().startsWith(base.toLowerCase()) ? own.slice(base.length) : null;
}

/** Whether `photo` is one the import was asked for: a named file, or one in a named folder. */
function inScope(scope: ImportScope, photo: CatalogPhoto): boolean {
  if (scope.kind === "all") return true;
  if (scope.files.includes(photo.relPath)) return true;
  return scope.folders.some(
    ({ relPath, recursive }) =>
      photo.folder === relPath || (recursive && (relPath === "" || photo.folder.startsWith(`${relPath}/`))),
  );
}

function openOptions(req: ImportRequest): StorageOpenOptions {
  const options: StorageOpenOptions = {
    lock: { owner: "slu", whenHeld: "fail", waitMs: 0, verifyBeforeWrite: true },
    keepBackup: req.keepBackup,
  };
  if (req.scope.kind === "some") options.importOnly = { files: req.scope.files, folders: req.scope.folders };
  return options;
}

/** Imports what `req` asks for and answers with its events, ending on "import-done".
 *  Throws an EngineFailure when the project can't be opened, or is held. */
export async function runImport(
  req: ImportRequest,
  out: RequestOut,
  signal: AbortSignal,
  over: Partial<ImportDeps> = {},
): Promise<void> {
  const deps: ImportDeps = { ...DEFAULT_DEPS, ...over };
  const { id, project } = req;
  const root = project.root;

  // Events go out in the order they happen, after the plan, which waits on a read.
  let sending: Promise<void> = Promise.resolve();
  const send = (event: EngineEvent | (() => Promise<EngineEvent>)) => {
    sending = sending.then(async () => out.emit(typeof event === "function" ? await event() : event));
  };

  let workingDir = "";
  let editedAtOpen = new Set<string>();
  let planned = false;
  const plan = (newFiles: number) => async (): Promise<EngineEvent> => {
    const inFolder = slashed(workingDir).toLowerCase() === `${slashed(root)}/.safelight`.toLowerCase();
    const created = workingDir !== "" && !(await deps.exists(`${workingDir}/catalog.json`));
    return { id, type: "import-plan", workingDir, location: inFolder ? "in-folder" : "external", created, newFiles };
  };

  const fileFailed = (handle: FileSystemFileHandle, error: string) => {
    const path = deps.pathOf(handle);
    const relPath = (path === null ? null : relativeTo(root, path)) ?? handle.name;
    send({ id, type: "import-file", relPath, state: "failed", error });
  };
  const walkDeps: ProjectStorageDeps = {
    ...deps.storageDeps,
    async importPhoto(fileHandle, directoryHandle) {
      try {
        const built = await deps.storageDeps.importPhoto(fileHandle, directoryHandle);
        if (!built) fileFailed(fileHandle, "couldn't be read");
        return built;
      } catch (error) {
        fileFailed(fileHandle, error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
  };

  let opened: OpenedProject;
  try {
    opened = await deps.open(
      deps.directory(root),
      walkDeps,
      (photo) => send({ id, type: "import-file", relPath: photo.relPath, photoId: photo.id, state: photo.width === 0 ? "no-preview" : "ok" }),
      (storage, rawCacheDir) => {
        const raw = deps.pathOf(rawCacheDir);
        workingDir = raw === null ? "" : raw.replace(/[/\\]+raw[/\\]*$/, "");
        // Read before the walk drops the records whose file is gone, edits and all.
        void storage.getAllEditStates().then((edits) => {
          editedAtOpen = new Set(edits.filter((e) => e.currentIndex > 0).map((e) => e.photoId));
        });
      },
      (done, total) => {
        if (!planned) {
          planned = true;
          send(plan(total));
        }
        send({ id, type: "progress", phase: "files", done, total });
      },
      signal,
      openOptions(req),
    );
  } catch (error) {
    await sending;
    if (error instanceof LockLostError) {
      out.emit({ id, type: "import-done", moved: [], dropped: [], pending: 0, stopped: "safelight-opened" });
      return;
    }
    if (error instanceof ProjectLockedError) {
      const { app, pid } = error.heldBy;
      throw new EngineFailure("locked", `The catalogue of ${root} is held by ${app} (pid ${pid}).`, error.heldBy);
    }
    throw new EngineFailure("project", `${root} can't be opened: ${error instanceof Error ? error.message : String(error)}`);
  }

  const { storage } = opened;
  const scoped = opened.photos.filter((p) => inScope(req.scope, p));
  setCatalogStorage(storage);
  useCatalogStore.getState().replaceCatalog(scoped);
  // Saved and given back however the import ends, so a later request in this
  // engine starts on no catalogue.
  const letGo = async () => {
    // Closes the storage it replaces.
    setCatalogStorage(null);
    await storage.released();
    useCatalogStore.getState().replaceCatalog([]);
  };

  let stopped: Stopped = signal.aborted ? "interrupted" : null;
  try {
    await storage.flush();
    if (!stopped && req.metadata) {
      await readCameraData(scoped);
      if (!signal.aborted) await deps.repairMissingPreviews(scoped, merge, signal);
      if (signal.aborted) stopped = "interrupted";
      await storage.flush();
    }
  } catch (error) {
    if (!(error instanceof LockLostError)) {
      await letGo();
      throw error;
    }
    stopped = "safelight-opened";
  }
  const pending = useCatalogStore.getState().photos.filter((p) => p.metadataPending).length;
  await letGo();

  await sending;
  out.emit({
    id,
    type: "import-done",
    moved: opened.moved,
    dropped: opened.dropped.map((d) => ({ id: d.id, relPath: d.relPath, edited: editedAtOpen.has(d.id) })),
    pending,
    stopped,
  });

  function merge(photo: CatalogPhoto, change: RebuiltChange) {
    useCatalogStore.getState().mergeRebuiltPhoto(photo.id, change);
  }

  /** The GUI's camera-data pass, a photo at a time so each can be counted. */
  async function readCameraData(photos: CatalogPhoto[]): Promise<void> {
    const todo = photos.filter((p) => p.metadataPending);
    send({ id, type: "progress", phase: "camera-data", done: 0, total: todo.length });
    let done = 0;
    for (const photo of todo) {
      if (signal.aborted) return;
      await deps.readPendingMetadata([photo], merge, signal);
      send({ id, type: "progress", phase: "camera-data", done: ++done, total: todo.length, photoId: photo.id });
    }
  }
}
