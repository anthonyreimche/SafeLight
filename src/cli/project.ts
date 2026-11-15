// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Finds the project a photo belongs to and opens its catalogue for reading or,
// under the writer lock, for writing (cli-plumbing §1.3-1.4).

import { stat } from "node:fs/promises";
import path from "node:path";
import type { CatalogPhoto, EditState } from "@/catalog/types";
import type { NativeFsBridge } from "@/extensions/api/native-bridge";
import type { OpenedProject, ProjectStorage, ProjectStorageDeps } from "@/project/project-storage";
import { ProjectLockedError, type StorageOpenOptions } from "@/project/storage-options";
import { catalogueBase } from "./node-fs";
import {
  CliError,
  type CliEnv,
  type ProjectRef,
  type ProjectService,
  type WriteSession,
} from "./types";

const CATALOG_FILE = "catalog.json";
const LOCK_POLL_MS = 200;

/** A drive or volume root, a network share, or a home folder: the same places the
 *  app refuses to make a project of (`holdsTooMuch` in project-store.ts). */
function holdsTooMuch(dir: string): boolean {
  const p = dir.replace(/\\/g, "/").replace(/(?!^)\/+/g, "/").replace(/\/$/, "");
  return (
    /^([A-Za-z]:)?$/.test(p) ||
    /^\/\/[^/]+\/[^/]+$/.test(p) ||
    /^([A-Za-z]:)?\/(home|Users)\/[^/]+$/i.test(p) ||
    /^\/(Volumes|mnt)\/[^/]+$/.test(p) ||
    /^\/(run\/)?media\/[^/]+\/[^/]+$/.test(p)
  );
}

/** The name key a photo's relPath is matched by: forward slashes, NFC, and folded
 *  to one case where the file system ignores case (as reattach.ts's pathKey). */
function relKey(relPath: string, foldCase: boolean): string {
  const key = relPath.replace(/[/\\]+/g, "/").normalize("NFC");
  return foldCase ? key.toLowerCase() : key;
}

// The storage's work that needs no app: nothing is imported, no previews built.
const NO_IMPORT: ProjectStorageDeps = {
  isSupportedName: () => false,
  importPhoto: async () => null,
  buildPreviewBlob: async () => null,
  persistPreviews: () => false,
  emitPhotoImport: async () => null,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Session implements WriteSession {
  readonly project: ProjectRef;
  private readonly opened: OpenedProject;
  private readonly foldCase: boolean;
  private readonly byRelPath: Map<string, CatalogPhoto>;
  private readonly writes: boolean;
  private closed = false;

  constructor(project: ProjectRef, opened: OpenedProject, foldCase: boolean, writes: boolean) {
    this.project = project;
    this.opened = opened;
    this.foldCase = foldCase;
    this.writes = writes;
    this.byRelPath = new Map(opened.photos.map((p) => [relKey(p.relPath, foldCase), p]));
  }

  private get storage(): ProjectStorage {
    return this.opened.storage;
  }

  photos(): readonly CatalogPhoto[] {
    return this.opened.photos;
  }

  photoByRelPath(relPath: string): CatalogPhoto | undefined {
    return this.byRelPath.get(relKey(relPath, this.foldCase));
  }

  edit(photoId: string): Promise<EditState | undefined> {
    return this.storage.getEditState(photoId);
  }

  async putEdits(states: EditState[]): Promise<void> {
    await this.storage.putEditStates(states);
  }

  async putPhotos(photos: CatalogPhoto[]): Promise<void> {
    await this.storage.putPhotos(photos);
  }

  /** Writes what was stored, then waits until the storage is done with the file
   *  and has given its lock back, so the process can exit. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.writes) await this.storage.flush();
    } finally {
      this.storage.close();
      await this.storage.released();
    }
  }
}

export function createProjectService(env: CliEnv, bridge: NativeFsBridge): ProjectService {
  const foldCase = /^(win|darwin|mac)/i.test(env.platform);

  // As the app reads it: getSettings().externalCatalogDir.trim() || null.
  const catalogBase = (): string | null => catalogueBase(env.userData).trim() || null;

  /** The project whose folder is `dir`, when it holds a catalogue. */
  const projectAt = async (dir: string): Promise<ProjectRef | null> => {
    const inFolder = path.join(dir, ".safelight");
    if (await bridge.exists(path.join(inFolder, CATALOG_FILE))) {
      return { root: dir, workingDir: inFolder, location: "in-folder" };
    }
    const pointed = (await bridge.getSpilloverPointer?.(dir)) ?? null;
    if (pointed !== null && (await bridge.exists(path.join(pointed, CATALOG_FILE)))) {
      return { root: dir, workingDir: pointed, location: "external" };
    }
    // Which of several separate catalogues is this card's, ProjectStorage decides
    // as it opens; any of them makes the folder a project.
    const base = catalogBase();
    for (const variant of (await bridge.externalCatalogVariants?.(dir, base)) ?? [1]) {
      const external = (await bridge.externalCatalogDir?.(dir, base, false, variant)) ?? null;
      if (external !== null && (await bridge.exists(path.join(external, CATALOG_FILE)))) {
        return { root: dir, workingDir: external, location: "external" };
      }
    }
    return null;
  };

  const open = async (
    project: ProjectRef,
    options: StorageOpenOptions,
  ): Promise<Session> => {
    // Loaded here, after the host shims are installed: it reads window at import.
    const [{ ProjectStorage }, { nativeDirectoryHandle }] = await Promise.all([
      import("@/project/project-storage"),
      import("@/project/native-fs"),
    ]);
    const opened = await ProjectStorage.open(
      nativeDirectoryHandle(project.root),
      NO_IMPORT,
      undefined,
      undefined,
      undefined,
      undefined,
      options,
    );
    return new Session(project, opened, foldCase, options.readOnly !== true);
  };

  return {
    async find(absPath) {
      let dir = path.resolve(absPath);
      const isFolder = await stat(dir).then((s) => s.isDirectory(), () => false);
      if (!isFolder) dir = path.dirname(dir);
      for (;;) {
        if (!holdsTooMuch(dir)) {
          const project = await projectAt(dir);
          if (project) return project;
        }
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
      }
    },

    openRead(project) {
      return open(project, { recordsOnly: true, readOnly: true });
    },

    async openWrite(project, waitSeconds, signal) {
      const deadline = Date.now() + (waitSeconds ?? 0) * 1000;
      for (;;) {
        if (signal?.aborted) throw new CliError(1, "Stopped.");
        try {
          return await open(project, {
            recordsOnly: true,
            lock: { owner: "slu", whenHeld: "fail", waitMs: 0 },
          });
        } catch (error) {
          if (!(error instanceof ProjectLockedError)) throw error;
          if (Date.now() >= deadline) {
            throw new CliError(
              4,
              `Safelight has ${project.root} open. Close the folder there, or add --wait.`,
            );
          }
          await sleep(Math.min(LOCK_POLL_MS, Math.max(0, deadline - Date.now())));
        }
      }
    },
  };
}
