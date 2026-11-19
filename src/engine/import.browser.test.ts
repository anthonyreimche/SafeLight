// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// `slu import` end to end in Chromium, against the GUI's open of the same
// folder: a camera JPEG and a DNG whose embedded preview the import takes, the
// DNG's camera data read after. The catalogue each writes must hold the same
// records, ids and times aside. Runs from vitest.webgl.config.ts.

import { describe, expect, it } from "vitest";
import { setCatalogStorage } from "@/catalog/storage";
import type { CatalogPhoto } from "@/catalog/types";
import { readPendingMetadata, repairMissingPreviews } from "@/modules/library/import-passes";
import { fsaDirectoryHandle, MemoryFs } from "@/project/memory-fs.test-support";
import { ProjectStorage } from "@/project/project-storage";
import { storageDeps } from "@/project/storage-deps";
import { TIFF_TAG } from "@/raw/tiff";
import { TYPE, asciiField, buildTiffWithTrailer, field } from "@/raw/tiff.test-support";
import { taggedJpeg } from "@/raw/tagged-jpeg.test-support";
import { useCatalogStore, type RebuiltChange } from "@/state/catalog-store";
import type { EngineEvent } from "./protocol";
import { runImport } from "./import";

const DNG_VERSION = 0xc612;

/** A DNG past the import's first 1 MiB read, whose embedded preview lies within it
 *  and reaches the grid's preview size: imported from the preview, camera data pending. */
async function dngWithPreview(): Promise<Uint8Array> {
  const preview = await taggedJpeg(1024, 682, 1);
  const trailer = new Uint8Array(preview.length + 2 ** 20);
  trailer.set(preview);
  const { buffer } = buildTiffWithTrailer(
    [
      {
        fields: [
          asciiField(TIFF_TAG.Make, "Safelight"),
          asciiField(TIFF_TAG.Model, "Test Camera"),
          field(DNG_VERSION, TYPE.BYTE, 1, 4, 0, 0),
        ],
      },
    ],
    { trailer },
  );
  return new Uint8Array(buffer);
}

async function folder(fs: MemoryFs, root: string, files: Record<string, Uint8Array>) {
  await fs.mkdir(root);
  for (const [name, bytes] of Object.entries(files)) await fs.write(`${root}/${name}`, bytes);
}

const merge = (photo: CatalogPhoto, change: RebuiltChange) =>
  useCatalogStore.getState().mergeRebuiltPhoto(photo.id, change);

/** What the GUI does when it opens a folder: the open's walk, then its passes
 *  over every photo (project-store openProject), then the save. */
async function guiOpen(root: FileSystemDirectoryHandle): Promise<void> {
  const opened = await ProjectStorage.open(root, storageDeps);
  setCatalogStorage(opened.storage);
  useCatalogStore.getState().finalizeCatalog(opened.photos);
  await opened.storage.flush();
  await repairMissingPreviews(opened.photos, merge);
  await readPendingMetadata(opened.photos, merge);
  await opened.storage.flush();
  setCatalogStorage(null);
  await opened.storage.released();
  useCatalogStore.getState().replaceCatalog([]);
}

type Stored = Record<string, unknown> & { relPath: string };

async function records(fs: MemoryFs, root: string): Promise<Stored[]> {
  const { data } = await fs.read(`${root}/.safelight/catalog.json`);
  const catalog = JSON.parse(new TextDecoder().decode(data)) as { photos: Stored[] };
  return catalog.photos
    .map(({ id: _id, dateImported: _imported, dateCreated: _created, ...rest }) => rest as Stored)
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
}

describe("an engine import in Chromium", () => {
  it("stores the records the GUI's open of the same folder stores", async () => {
    const jpeg = await taggedJpeg(800, 600, 1);
    const dng = await dngWithPreview();
    const fs = new MemoryFs();
    await folder(fs, "/gui", { "a.jpg": jpeg, "b.dng": dng });
    await folder(fs, "/slu", { "a.jpg": jpeg, "b.dng": dng });

    await guiOpen(fsaDirectoryHandle(fs, "/gui"));

    const events: EngineEvent[] = [];
    await runImport(
      { id: 1, type: "import", project: { root: "/slu" }, scope: { kind: "all" }, metadata: true, keepBackup: true },
      { emit: (event) => events.push(event), frame: () => {} },
      new AbortController().signal,
      { directory: (root) => fsaDirectoryHandle(fs, root) },
    );

    expect(events.filter((e) => e.type === "import-file").map((e) => e.type === "import-file" && [e.relPath, e.state]).sort()).toEqual([
      ["a.jpg", "ok"],
      ["b.dng", "ok"],
    ]);
    // The DNG came in from its preview, its camera data read after.
    expect(events.filter((e) => e.type === "progress" && e.phase === "camera-data").at(-1)).toMatchObject({ done: 1, total: 1 });
    expect(events.at(-1)).toMatchObject({ type: "import-done", pending: 0, stopped: null });

    const gui = await records(fs, "/gui");
    const slu = await records(fs, "/slu");
    expect(gui.map((r) => [r.relPath, r.width, r.fileSize, r.metadataPending])).toEqual([
      ["a.jpg", 800, jpeg.length, undefined],
      ["b.dng", 1024, dng.length, undefined],
    ]);
    expect(slu).toEqual(gui);
    expect(useCatalogStore.getState().photos).toEqual([]);
  });
});
