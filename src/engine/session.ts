// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What the engine page does for `slu`: export through the export path and
// preview through the live path, as the GUI draws each, and grid previews as
// stored. For these the project's catalogue is read and never written: `slu` in
// Node owns the edits, and the engine only renders them (a `--try` look comes
// with the request). Nothing here commits a step or redraws a thumbnail. The one
// write is an import (import.ts), after which the catalogue is read again.

import type { CatalogPhoto, EditState } from "@/catalog/types";
import { freshParams } from "@/catalog/types";
import { historyCursor } from "@/catalog/history-cursor";
import { convertedTargetEdge } from "@/catalog/input-profiles";
import { loadPhotoImage, photoSourceKey } from "@/catalog/load-image";
import { setCatalogStorage, type CatalogStorage } from "@/catalog/storage";
import { isPreview, keptPreview, noteSource, previewReason } from "@/hooks/develop-sources";
import { applyPanelBypass, bypassParamBag } from "@/modules/develop/panel-bypass";
import {
  exportExtension,
  exportFilename,
  getDefaultExportSettings,
  renderPhotosToBlobs,
  resolveFilenameTemplate,
  uniqueName,
  type ExportFormat,
  type ExportSettings,
} from "@/modules/export/export-image";
import { nativeDirectoryHandle, nativeFs, nativePathOf } from "@/project/native-fs";
import { ProjectStorage, type OpenedProject, type ProjectStorageDeps } from "@/project/project-storage";
import { storageDeps } from "@/project/storage-deps";
import type { StorageOpenOptions } from "@/project/storage-options";
import { getRenderBridge, type FrameResult, type RenderBridge } from "@/rendering/render-bridge";
import { frameStageBag } from "@/rendering/stage-bag";
import { useCatalogStore } from "@/state/catalog-store";
import { useDevelopStore } from "@/state/develop-store";
import { showsEdit, standsForPhoto } from "@/state/fallback-rules";
import { getSettings } from "@/state/settings-store";
import type { ExportWireSettings, LookOverride, PreviewRegion, ProjectWire } from "./protocol";
import { runImport } from "./import";
import { EngineFailure, type ExportRequest, type ImportRequest, type PreviewRequest, type RequestOut, type ThumbsRequest } from "./rpc";

/** The project as the engine reads it: its records, the storage they came from,
 *  and each photo's grid preview as the Library shows it. */
export interface OpenedRecords {
  photos: CatalogPhoto[];
  storage: CatalogStorage;
  readPreview(photoId: string): Promise<Blob | null>;
}

export interface EncodedFrame { bytes: Uint8Array; width: number; height: number }

export interface SessionDeps {
  /** Reads the project at `root` with `options`. */
  openProject(root: string, options: StorageOpenOptions): Promise<OpenedRecords>;
  bridge(): RenderBridge;
  renderPhotos: typeof renderPhotosToBlobs;
  loadImage: typeof loadPhotoImage;
  /** `bitmap` fitted inside maxWidth × maxHeight, as RGBA bytes or a PNG. Closes it. */
  encodeFrame(bitmap: ImageBitmap, maxWidth: number, maxHeight: number, encoding: "png" | "rgba"): Promise<EncodedFrame>;
  exists(path: string): Promise<boolean>;
  writeFile(path: string, blob: Blob): Promise<void>;
  decodePreview(blob: Blob): Promise<ImageBitmap>;
  importProject(req: ImportRequest, out: RequestOut, signal: AbortSignal): Promise<void>;
}

/** The engine never writes a project, and takes no lock: Node holds that. */
export const READ_RECORDS: StorageOpenOptions = { recordsOnly: true, readOnly: true };

type OpenStorage = (
  root: FileSystemDirectoryHandle,
  deps: ProjectStorageDeps,
  onPhoto: undefined,
  onSkeletons: undefined,
  onProgress: undefined,
  signal: undefined,
  options: StorageOpenOptions,
) => Promise<OpenedProject>;

const openStorage: OpenStorage = ProjectStorage.open.bind(ProjectStorage);

async function openProject(root: string, options: StorageOpenOptions): Promise<OpenedRecords> {
  const opened = await openStorage(nativeDirectoryHandle(root), storageDeps, undefined, undefined, undefined, undefined, options);
  const { storage } = opened;
  return {
    photos: opened.photos,
    storage,
    // The disk copy only: records read without a walk carry no file to build
    // one from, so a photo with none, or turned since, has none here.
    readPreview: (photoId) => storage.readPreview(photoId, { hold: false, build: false }),
  };
}

/** `bitmap` scaled down to fit maxWidth × maxHeight (never up), as the
 *  Develop canvas scales a frame to fit the view. */
export async function encodeFrame(
  bitmap: ImageBitmap,
  maxWidth: number,
  maxHeight: number,
  encoding: "png" | "rgba",
): Promise<EncodedFrame> {
  const scale = Math.min(1, maxWidth / bitmap.width, maxHeight / bitmap.height);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new EngineFailure("render", "no 2D canvas to read the frame with");
  }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  if (encoding === "rgba") return { bytes: new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer), width, height };
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
}

const pathJoin = (dir: string, name: string): string => {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return `${dir.replace(/[/\\]+$/, "")}${sep}${name}`;
};

const splitPath = (path: string): { dir: string; name: string } => {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  // A file at a root ("/a.png") keeps the root as its folder.
  return { dir: at > 0 ? path.slice(0, at) : path.slice(0, at + 1), name: path.slice(at + 1) };
};

// A path as export-image compares one: one kind of separator, case folded.
const pathKey = (path: string): string => path.replace(/[/\\]+/g, "/").normalize("NFC").toLowerCase();

const DEFAULT_DEPS: SessionDeps = {
  openProject,
  bridge: getRenderBridge,
  renderPhotos: renderPhotosToBlobs,
  loadImage: loadPhotoImage,
  encodeFrame,
  exists: async (path) => (await nativeFs()?.exists(path)) ?? false,
  writeFile: async (path, blob) => {
    const { dir, name } = splitPath(path);
    const fh = await nativeDirectoryHandle(dir).getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
  },
  decodePreview: (blob) => createImageBitmap(blob),
  importProject: (req, out, signal) => runImport(req, out, signal),
};

const FORMATS: Record<NonNullable<ExportWireSettings["format"]>, ExportFormat> = {
  jpg: "image/jpeg",
  png: "image/png",
  tiff: "image/tiff",
  webp: "image/webp",
};

/** The export settings a request asks for, over the GUI's defaults
 *  (Preferences ▸ Export) for everything it leaves out. */
export function exportSettingsFor(wire: ExportWireSettings, defaults: ExportSettings = getDefaultExportSettings()): ExportSettings {
  const settings: ExportSettings = { ...defaults, bundle: false, delivery: "folder" };
  if (wire.format) settings.format = FORMATS[wire.format];
  if (wire.quality !== undefined) settings.quality = wire.quality / 100;
  if (wire.longEdge !== undefined) settings.longEdge = wire.longEdge === "original" ? null : wire.longEdge;
  if (wire.colourSpace) settings.colorSpace = wire.colourSpace;
  if (wire.bitDepth) {
    settings.tiffBitDepth = wire.bitDepth;
    settings.pngBitDepth = wire.bitDepth;
  }
  if (wire.nameTemplate !== undefined) settings.filenameTemplate = wire.nameTemplate;
  if (wire.existing) settings.ifExists = wire.existing;
  return settings;
}

/** `state` with the step it opens on carrying `look` over it, or a first step of
 *  the untouched photo with `look` over it when it has no edit. */
function withLook(state: EditState | undefined, photoId: string, look: LookOverride, asShot: number | undefined): EditState {
  if (!state || state.stack.length === 0) {
    const params = { ...freshParams(asShot), ...look.params };
    return { photoId, stack: [{ timestamp: 0, label: "Original", params, paramBag: { ...look.paramBag } }], currentIndex: 0 };
  }
  const at = historyCursor(state.currentIndex, state.stack.length);
  const step = state.stack[at];
  const stack = state.stack.slice();
  stack[at] = { ...step, params: { ...step.params, ...look.params }, paramBag: { ...step.paramBag, ...look.paramBag } };
  return { ...state, stack, currentIndex: at };
}

/** The catalogue the app's code reads while the engine renders: `stored`'s
 *  edits (with `look` over the step each opens on) and records. Every write is
 *  dropped, so a decode that learns a photo's white balance, say, changes the
 *  record in memory only. */
function readOnlyCatalog(stored: CatalogStorage, look: LookOverride | undefined): CatalogStorage {
  const dropped = async () => {};
  const asShotOf = (id: string) => useCatalogStore.getState().photos.find((p) => p.id === id)?.exif.colorTemperature;
  return {
    putPhoto: dropped,
    putPhotos: dropped,
    deletePhotos: dropped,
    putEditState: dropped,
    putEditStates: dropped,
    putPhotoBlob: dropped,
    flush: dropped,
    async getEditState(photoId) {
      const state = await stored.getEditState(photoId);
      return look ? withLook(state, photoId, look, asShotOf(photoId)) : state;
    },
    heldPhoto: (photoId) => stored.heldPhoto?.(photoId),
    ...(stored.getPhotoBlob ? { getPhotoBlob: stored.getPhotoBlob.bind(stored) } : {}),
  };
}

/** `photo` with handles on its file, made from the project root and its
 *  relPath when the catalogue's record came without them. */
async function withHandles(root: string, photo: CatalogPhoto): Promise<CatalogPhoto> {
  if (photo.fileHandle) return photo;
  const parts = photo.relPath.split(/[/\\]/).filter(Boolean);
  const name = parts.pop();
  if (!name) return photo;
  // Native handles are lazy: nothing is read until the file is.
  let directory = nativeDirectoryHandle(root);
  for (const part of parts) directory = await directory.getDirectoryHandle(part);
  return { ...photo, directoryHandle: directory, fileHandle: await directory.getFileHandle(name) };
}

const NO_BYPASS: Record<string, boolean> = {};

// Photos rendered per renderer: one call holds every blob it made until it returns.
const EXPORT_BATCH = 8;

export class EngineSession {
  private readonly deps: SessionDeps;
  private project: { wire: ProjectWire; records: OpenedRecords; catalogue: string | undefined } | null = null;
  private displaySet = false;

  constructor(deps: Partial<SessionDeps> = {}) {
    this.deps = { ...DEFAULT_DEPS, ...deps };
  }

  async export(req: ExportRequest, out: RequestOut, signal?: AbortSignal): Promise<void> {
    await this.open(req.project, req.overrides);
    const settings = exportSettingsFor(req.settings);
    const { target } = req;
    const photos: CatalogPhoto[] = [];
    for (const photoId of req.photoIds) {
      const photo = this.photo(photoId);
      if (photo) photos.push(photo);
      else out.emit({ id: req.id, type: "error", code: "project", message: "This photo isn't in the catalogue.", photoId });
    }
    if (target.kind === "file" && photos.length > 1) throw new EngineFailure("internal", "A file target takes one photo.");

    const used = new Set<string>();
    const total = req.photoIds.length;
    let done = total - photos.length;
    for (let at = 0; at < photos.length && !signal?.aborted; at += EXPORT_BATCH) {
      const rendered = await this.deps.renderPhotos(photos.slice(at, at + EXPORT_BATCH), settings);
      for (const { photo, blob, width, height } of rendered) {
        if (!blob) {
          out.emit({ id: req.id, type: "error", code: "render", message: `${photo.filename} couldn't be rendered.`, photoId: photo.id });
        } else {
          try {
            await this.deliver(req, out, settings, used, photo, blob, width, height);
          } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            out.emit({ id: req.id, type: "error", code: "internal", message: `${photo.filename} couldn't be written: ${reason}`, photoId: photo.id });
          }
        }
        out.emit({ id: req.id, type: "progress", done: ++done, total, photoId: photo.id });
      }
    }
  }

  async preview(req: PreviewRequest, out: RequestOut, signal?: AbortSignal): Promise<void> {
    await this.open(req.project, req.overrides, req.catalogue);
    const photo = this.photo(req.photoId);
    if (!photo) throw new EngineFailure("project", "This photo isn't in the catalogue.");
    const bridge = this.deps.bridge();
    await bridge.ready;
    if (bridge.availability === "failed") throw new EngineFailure("render", "The graphics renderer couldn't start.");
    const warn = (message: string) => out.emit({ id: 0, type: "log", level: "warn", message });
    const frame = await this.drawLive(bridge, photo, warn, req.region ? { region: req.region, width: req.width, height: req.height } : null);
    if (signal?.aborted) {
      frame.bitmap.close();
      return;
    }
    const encoded = await this.deps.encodeFrame(frame.bitmap, req.width, req.height, req.encoding);
    out.frame(encoded.bytes, (n) => ({
      id: req.id,
      type: "frame",
      frame: n,
      width: encoded.width,
      height: encoded.height,
      encoding: req.encoding,
    }));
  }

  /** Each photo's stored grid preview, fitted inside edge × edge, as a frame
   *  naming its photo. A photo without one is an error that names it. */
  async thumbs(req: ThumbsRequest, out: RequestOut, signal?: AbortSignal): Promise<void> {
    const records = await this.open(req.project, undefined);
    for (const photoId of req.photoIds) {
      if (signal?.aborted) return;
      const photo = this.photo(photoId);
      if (!photo) {
        out.emit({ id: req.id, type: "error", code: "project", message: "This photo isn't in the catalogue.", photoId });
        continue;
      }
      const blob = await records.readPreview(photoId);
      if (!blob) {
        out.emit({ id: req.id, type: "error", code: "decode", message: `${photo.filename} has no preview yet.`, photoId });
        continue;
      }
      let encoded: EncodedFrame;
      try {
        encoded = await this.deps.encodeFrame(await this.deps.decodePreview(blob), req.edge, req.edge, req.encoding);
      } catch {
        out.emit({ id: req.id, type: "error", code: "decode", message: `The preview of ${photo.filename} can't be read.`, photoId });
        continue;
      }
      out.frame(encoded.bytes, (frame) => ({
        id: req.id,
        type: "frame",
        frame,
        width: encoded.width,
        height: encoded.height,
        encoding: req.encoding,
        photoId,
      }));
    }
  }

  /** Imports as the request asks (import.ts), holding no catalogue of its own
   *  meanwhile: the next request reads the project again, as the import left it. */
  async import(req: ImportRequest, out: RequestOut, signal: AbortSignal): Promise<void> {
    await this.close();
    useCatalogStore.getState().replaceCatalog([]);
    await this.deps.importProject(req, out, signal);
  }

  async close(): Promise<void> {
    setCatalogStorage(null);
    this.project?.records.storage.close?.();
    this.project = null;
  }

  /** Reads the project once per engine run, or again when `catalogue` names a
   *  stamp it wasn't read at, and has the app read it through readOnlyCatalog
   *  with this request's look. */
  private async open(wire: ProjectWire, look: LookOverride | undefined, catalogue?: string): Promise<OpenedRecords> {
    let project = this.project;
    const stale = catalogue !== undefined && project?.catalogue !== catalogue;
    if (project?.wire.root !== wire.root || project.wire.workingDir !== wire.workingDir || stale) {
      await this.close();
      let records: OpenedRecords;
      try {
        records = await this.deps.openProject(wire.root, READ_RECORDS);
      } catch (e) {
        throw new EngineFailure("project", `The catalogue of ${wire.root} can't be read: ${e instanceof Error ? e.message : String(e)}`);
      }
      project = { wire, records, catalogue };
      this.project = project;
      useCatalogStore.getState().replaceCatalog(await Promise.all(records.photos.map((p) => withHandles(wire.root, p))));
    }
    setCatalogStorage(readOnlyCatalog(project.records.storage, look));
    return project.records;
  }

  private photo(photoId: string): CatalogPhoto | undefined {
    return useCatalogStore.getState().photos.find((p) => p.id === photoId);
  }

  private async deliver(
    req: ExportRequest,
    out: RequestOut,
    settings: ExportSettings,
    used: Set<string>,
    photo: CatalogPhoto,
    blob: Blob,
    width: number,
    height: number,
  ): Promise<void> {
    const colourSpace = settings.colorSpace ?? "srgb";
    const { target } = req;
    if (target.kind === "stdout") {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      out.frame(bytes, (frame) => ({ id: req.id, type: "exported", photoId: photo.id, frame, width, height, colourSpace, bytes: bytes.length }));
      return;
    }
    const ext = exportExtension(settings.format, blob.type);
    let dir: string;
    let rawName: string;
    if (target.kind === "file") {
      ({ dir, name: rawName } = splitPath(target.path));
    } else {
      dir = target.dir;
      rawName = settings.filenameTemplate
        ? resolveFilenameTemplate(settings.filenameTemplate, photo, settings.format, ext)
        : exportFilename(photo, settings.format, ext);
    }
    const path = await this.targetPath(dir, rawName, used, settings.ifExists === "replace");
    await this.deps.writeFile(path, blob);
    out.emit({ id: req.id, type: "exported", photoId: photo.id, path, width, height, colourSpace, bytes: blob.size });
  }

  /** Where a file named `rawName` goes in `dir`: under that name, or the next
   *  numbered one while the name is taken, by this batch or on disk. `replace`
   *  writes over a file there, but never over a photo's original. */
  private async targetPath(dir: string, rawName: string, used: Set<string>, replace: boolean): Promise<string> {
    const originals = new Set(
      useCatalogStore.getState().photos.flatMap((p) => {
        const own = nativePathOf(p.fileHandle);
        return own === null ? [] : [pathKey(own)];
      }),
    );
    let name = uniqueName(rawName, used);
    for (;;) {
      const path = pathJoin(dir, name);
      if (!(await this.deps.exists(path))) return path;
      if (replace && !originals.has(pathKey(path))) return path;
      name = uniqueName(rawName, used);
    }
  }

  /** Draws `photo` as the Develop view does when it opens one, and resolves
   *  with the last frame of it: a frame whose prepasses were put off is followed
   *  by another, and only the final one is followed by its histogram. */
  private async drawLive(
    bridge: RenderBridge,
    photo: CatalogPhoto,
    warn: (message: string) => void,
    window: { region: PreviewRegion; width: number; height: number } | null,
  ): Promise<FrameResult> {
    if (!this.displaySet) {
      // The bytes go to a terminal, which shows sRGB, whatever screen this
      // hidden window is on.
      bridge.setMonitorTransform(null);
      bridge.setDisplaySpace("srgb");
      this.displaySet = true;
    }
    bridge.clearSource();
    if (window) bridge.setViewport(window.region, window.width, window.height);
    else bridge.setViewport(null);
    const key = photoSourceKey(photo);
    const maxEdge = getSettings().developMaxEdge;
    if (await bridge.bindSource(key)) {
      const kept = keptPreview(bridge, key);
      if (kept !== undefined) warn(`${photo.filename}: showing a preview of the photo${kept ? ` (${previewReason(kept) ?? "the original couldn't be decoded"})` : ""}.`);
    } else {
      const image = await this.deps.loadImage(photo, { sample: true, ...convertedTargetEdge(photo, maxEdge) });
      if (!image) {
        throw new EngineFailure(
          "decode",
          photo.decodeError ? `Can't show this photo: ${photo.decodeError}` : photo.fileHandle ? "Can't read this file." : "The original isn't available.",
        );
      }
      if (showsEdit(image)) {
        if (image.kind === "bitmap") image.bitmap.close();
        throw new EngineFailure("decode", "The original isn't available; only its edited preview is.");
      }
      if (isPreview(image)) {
        const reason = image.kind === "bitmap" ? previewReason(image.fallback) : null;
        warn(`${photo.filename}: showing a preview of the photo${reason ? ` (${reason})` : ""}.`);
      }
      const isFallback = image.kind === "float" ? (image.isFallbackPreview ?? false) : false;
      const source = image.kind === "bitmap" ? { kind: "bitmap" as const, bitmap: image.bitmap } : image;
      if (standsForPhoto(image)) {
        noteSource(bridge, key, image);
        bridge.uploadSource("main", key, source, maxEdge, isFallback);
      } else {
        bridge.setImage(source, maxEdge, isFallback);
      }
    }
    const gen = bridge.sourceGen;

    // After the decode, which may learn the as-shot white balance the edit's
    // default temperature is.
    await useDevelopStore.getState().loadEdit(photo.id, photo.exif.colorTemperature);
    const { params, paramBag, asShotTemperature } = useDevelopStore.getState();
    const drawn = applyPanelBypass(params, NO_BYPASS);
    const finalFrame = this.finalFrame(bridge, gen, warn);
    bridge.setAsShotTemperature(asShotTemperature);
    bridge.setContributedParams(frameStageBag(drawn, bypassParamBag(paramBag, NO_BYPASS)), paramBag);
    bridge.setParams(drawn);
    bridge.render(true);
    return finalFrame;
  }

  private finalFrame(bridge: RenderBridge, gen: number, warn: (message: string) => void): Promise<FrameResult> {
    return new Promise<FrameResult>((resolve, reject) => {
      let latest: FrameResult | null = null;
      const end = () => {
        bridge.setOnFrame(null);
        bridge.setOnHistogram(null);
        bridge.setOnHistogramError(null);
        bridge.setOnSourceError(null);
        bridge.setOnError(null);
      };
      const fail = (failure: EngineFailure) => {
        end();
        latest?.bitmap.close();
        reject(failure);
      };
      const settle = () => {
        if (!latest) return;
        end();
        resolve(latest);
      };
      bridge.setOnFrame((frame) => {
        if (frame.sourceGen < gen) {
          frame.bitmap.close();
          return;
        }
        latest?.bitmap.close();
        latest = frame;
      });
      bridge.setOnHistogram(settle);
      // The frame came; only its histogram failed.
      bridge.setOnHistogramError(settle);
      bridge.setOnSourceError((sourceGen, message) => {
        if (sourceGen === gen) fail(new EngineFailure("decode", `Can't show this photo: ${message}`));
      });
      bridge.setOnError((message) => {
        if (message.startsWith("render failed")) fail(new EngineFailure("render", message));
        else if (!message.startsWith("source failed")) warn(message);
      });
    });
  }
}

