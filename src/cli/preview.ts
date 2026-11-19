// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Renders one photo through the engine and prints it in the terminal.

import { readFile } from "node:fs/promises";
import type { CatalogPhoto } from "@/catalog/photo";
import { NEUTRAL_TEMPERATURE_K } from "@/catalog/defaults";
import { freshParams, normalizeParams, type EditState } from "@/catalog/types";
import { normalizeParamBag } from "@/extensions/param-registry";
import { currentLook } from "@/catalog/edit-steps";
import type { EngineEvent, LookOverride, ProjectWire } from "@/engine/protocol";
import type { EngineClient, EngineFrame } from "./engine-client";
import type { Output, ProgressItem, ProgressState } from "./output/types";
import { catalogueStamp, frameKey, type CachedFrame, type FrameSize, type PreviewCache } from "./preview-cache";
import {
  DEFAULT_CELL,
  detectGraphicsMode,
  encodeForTerminal,
  encodeItermJpeg,
  speaksIterm,
  supportsTrueColour,
  type CellSize,
  type TerminalProbe,
} from "./terminal-image";
import {
  CliError,
  type Assignment,
  type CliEnv,
  type GraphicsMode,
  type PreviewService,
  type ReadSession,
  type ProjectRef,
  type ProjectService,
  type ValueService, COMMAND } from "./types";

const MAX_COLUMNS = 120;

let nextRequestId = 1;
export const newRequestId = (): number => nextRequestId++;

export function projectWire(project: ProjectRef): ProjectWire {
  return { root: project.root, workingDir: project.workingDir, location: project.location };
}

export function asShotOf(photo: CatalogPhoto): number {
  return photo.exif.colorTemperature ?? NEUTRAL_TEMPERATURE_K;
}

/** The engine's own failures, as the exit codes cli-commands §3 names: the photo's fault is 2, the engine's is 3. */
export function engineError(event: Extract<EngineEvent, { type: "error" }>): CliError {
  const photoFault = event.code === "decode" || event.code === "project";
  return new CliError(photoFault ? 2 : 3, event.message);
}

export function isFrame(item: EngineEvent | EngineFrame): item is EngineFrame {
  return !("type" in item);
}

export interface TryServices { projects: ProjectService; values: ValueService; out: Output; strict: boolean }

/** The look with the `--try` values applied, for the engine to render without storing. */
export async function tryOverrides(
  services: TryServices,
  project: ProjectRef,
  photo: CatalogPhoto,
  assigns: Assignment[],
): Promise<LookOverride> {
  const session = await services.projects.openRead(project);
  let state;
  try {
    state = await session.edit(photo.id);
  } finally {
    await session.close();
  }
  const asShot = asShotOf(photo);
  const result = services.values.apply(currentLook(state, asShot), assigns, { asShot, strict: services.strict });
  for (const change of result.changes) {
    if (change.clamped) {
      services.out.warn({ message: `${change.info.label} ${change.clamped.requested} is past its limit, so it was set to ${services.out.formatValue(change.info, change.after)}.` });
    }
  }
  return { params: result.look.params, paramBag: result.look.paramBag };
}

/** The events of one request, with the wait for the first one (the engine starting, the first photo
 *  rendering) shown as a working lamp. */
export async function* withLamp<T>(out: Pick<Output, "working">, label: string, source: AsyncIterable<T>): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    let step = await out.working(label, iterator.next());
    while (!step.done) {
      yield step.value;
      step = await iterator.next();
    }
  } finally {
    await iterator.return?.();
  }
}

export interface ExportTracker {
  /** The engine is up: the first photo is being rendered. */
  begin(): void;
  exported(photoId: string, result: { path?: string; bytes: number }): void;
  failed(photoId: string, message: string): void;
  snapshot(label: string): ProgressState;
}

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/** Per-photo state for an export's progress: the engine reports each photo as it ends, and the time
 *  one took is the time since the one before it ended. */
export function createExportTracker(
  photos: readonly { id: string; name: string }[],
  folder: string | undefined,
  now: () => number = Date.now,
): ExportTracker {
  const startedAt = now();
  const items = new Map<string, ProgressItem>(photos.map((p) => [p.id, { name: p.name, state: "waiting" }]));
  let mark = startedAt;

  const startNext = (): void => {
    for (const item of items.values()) {
      if (item.state === "working") return;
      if (item.state === "waiting") { item.state = "working"; return; }
    }
  };
  const finish = (photoId: string, change: Partial<ProgressItem> & { state: "done" | "failed" }): void => {
    const item = items.get(photoId);
    if (!item || item.state === "done" || item.state === "failed") return;
    const at = now();
    Object.assign(item, { ms: at - mark }, change);
    mark = at;
    startNext();
  };

  return {
    begin() {
      mark = now();
      startNext();
    },
    exported(photoId, { path, bytes }) {
      finish(photoId, { state: "done", bytes, ...(path !== undefined && { name: baseName(path) }) });
    },
    failed(photoId, message) {
      finish(photoId, { state: "failed", error: message });
    },
    snapshot(label) {
      const list = [...items.values()].map((i) => ({ ...i }));
      return {
        label,
        done: list.filter((i) => i.state === "done" || i.state === "failed").length,
        total: list.length,
        items: list,
        ...(folder !== undefined && { folder }),
        startedAt,
      };
    },
  };
}

/** Widest a window can be and still leave room for the picture beside the values. */
const PICTURE_FROM_WIDTH = 96;
const PICTURE_COLUMNS = 28;

/** The app's stored preview as an iTerm2 inline picture, for terminals that take JPEG bytes as they are;
 *  null anywhere else, or when the app stored none. No engine runs. */
export async function cachedPicture(
  env: CliEnv,
  width: number,
  session: Pick<ReadSession, "previewFile">,
  photo: CatalogPhoto,
): Promise<Uint8Array | null> {
  if (!env.isTTY.stdout || width < PICTURE_FROM_WIDTH || !speaksIterm(env)) return null;
  const file = session.previewFile(photo);
  if (file === null) return null;
  try {
    return encodeItermJpeg(await readFile(file), PICTURE_COLUMNS, env);
  } catch {
    return null;
  }
}

function orientedAspect(photo: Pick<CatalogPhoto, "rotation" | "width" | "height">): number {
  const turned = photo.rotation % 180 !== 0;
  const w = turned ? photo.height : photo.width;
  const h = turned ? photo.width : photo.height;
  return w > 0 && h > 0 ? h / w : 2 / 3;
}

/** The frame the engine renders for a preview `columns` cells wide in this image mode. */
export function previewFrameSize(
  mode: Exclude<GraphicsMode, "none">,
  cell: CellSize | undefined,
  columns: number,
  photo: Pick<CatalogPhoto, "rotation" | "width" | "height">,
): FrameSize {
  const across = Math.max(1, Math.min(columns, MAX_COLUMNS));
  // a block cell is one pixel wide and two tall, so a pixel is square when the cell is 1:2
  const width = mode === "blocks" ? across : across * (cell ?? DEFAULT_CELL).width;
  let height = Math.max(1, Math.round(width * orientedAspect(photo)));
  if (mode === "blocks" && height % 2 === 1) height += 1;
  return { width, height, encoding: mode === "blocks" || mode === "sixel" ? "rgba" : "png" };
}

/** The look stored at history step `step` (counted from 1), as the engine's override. A photo with no
 *  history has one step: the look it opens on. */
export function lookAtStep(state: EditState | undefined, step: number, asShot: number): { overrides: LookOverride; step: number; of: number } {
  const stack = state?.stack ?? [];
  const of = Math.max(stack.length, 1);
  if (!Number.isInteger(step) || step < 1 || step > of) {
    throw new CliError(1, `Step ${step} isn't one of this photo's ${of} ${of === 1 ? "step" : "steps"}.`, `${COMMAND} history lists them.`);
  }
  const snapshot = stack[step - 1];
  const overrides = snapshot
    ? { params: normalizeParams(snapshot.params), paramBag: normalizeParamBag(snapshot.paramBag) }
    : { params: freshParams(asShot), paramBag: {} };
  return { overrides, step, of };
}

export type ResolveTry =(project: ProjectRef, photo: CatalogPhoto, assigns: Assignment[]) => Promise<LookOverride>;

export function createPreviewService(
  env: CliEnv,
  out: Output,
  engine: () => EngineClient,
  resolveTry?: ResolveTry,
  probe?: TerminalProbe,
  cache?: PreviewCache,
): PreviewService {
  return {
    async show(project, photo, opts) {
      // The prompt asks the terminal once; its later pictures are drawn the same way.
      const detected = !opts.mode && cache?.drawnAs ? { ...cache.drawnAs, reason: "" } : await detectGraphicsMode(env, opts.mode, probe);
      const mode: GraphicsMode = detected.mode;
      if (mode === "none") {
        out.warn({
          message: `Not showing the image: ${detected.reason}.`,
          hint: `${COMMAND} export writes the photo to a file; --graphics blocks forces coloured blocks.`,
        });
        return;
      }
      if (cache) cache.drawnAs = detected.cell ? { mode, cell: detected.cell } : { mode };
      const overrides = opts.tryAssigns?.length
        ? await (resolveTry ?? (() => { throw new CliError(1, "--try isn't available here."); }))(project, photo, opts.tryAssigns)
        : opts.overrides;

      const size = previewFrameSize(mode, detected.cell, opts.widthCols ?? out.options.width, photo);
      const catalogue = await catalogueStamp(project.workingDir);
      // Only the stored look is kept: one given for this showing alone (--try, --step) isn't the photo's.
      const key = cache && opts.look !== undefined && overrides === undefined ? frameKey(opts.look, size, catalogue) : null;
      const started = Date.now();
      let frame = key === null ? undefined : cache?.get(key);
      if (!frame) {
        frame = await renderPreview(project, photo, size, overrides, catalogue);
        if (key !== null) cache?.put(key, frame);
      }

      out.writeRaw(encodeForTerminal(mode, frame, env));
      out.print(out.previewCaption({
        mode,
        trueColour: mode !== "blocks" || supportsTrueColour(env),
        width: frame.width,
        height: frame.height,
        ms: Date.now() - started,
      }));
    },
  };

  async function renderPreview(
    project: ProjectRef,
    photo: CatalogPhoto,
    size: FrameSize,
    overrides: LookOverride | undefined,
    catalogue: string | undefined,
  ): Promise<CachedFrame> {
    let frameInfo: Extract<EngineEvent, { type: "frame" }> | null = null;
    let bytes: Uint8Array | null = null;
    const events = engine().request({ id: newRequestId(), type: "preview", project: projectWire(project), photoId: photo.id, ...size, overrides, ...(catalogue !== undefined && { catalogue }) });
    for await (const item of withLamp(out, "Rendering the preview…", events)) {
      if (isFrame(item)) {
        if (frameInfo && item.frame === frameInfo.frame) bytes = item.bytes;
      } else if (item.type === "frame") {
        frameInfo = item;
      } else if (item.type === "error") {
        throw engineError(item);
      }
    }
    if (!frameInfo || !bytes) throw new CliError(3, "The engine finished without sending the image.");
    return { width: frameInfo.width, height: frameInfo.height, encoding: frameInfo.encoding, bytes };
  }
}
