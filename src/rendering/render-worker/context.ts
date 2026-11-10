// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What the render worker's handlers share: the worker's state, how it answers
// the window, and the helpers more than one area of messages uses.

import type { DevelopParams } from "@/catalog/types";
import type { ResolvedPipeline } from "@/extensions/pipelines";
import { BUILTIN_RESOLVED } from "@/extensions/pipelines";
import type { ProcessingStageContribution, StageTextureData } from "@/extensions/types";
import type { ColorSpaceId, DisplaySpace } from "../color-space";
import type { MonitorTransform } from "../display-profile";
import type { WorkerRequest, WorkerResponse } from "../render-protocol";
import type { QuarantinedStage, StageBuildEvent, WebGLRenderer } from "../webgl/renderer";

export interface WorkerState {
  canvas: OffscreenCanvas | null;
  renderer: WebGLRenderer | null;
  // Separate offscreen canvas + renderer for thumbnails so a thumbnail render
  // doesn't clobber the develop canvas mid-frame.
  thumbCanvas: OffscreenCanvas | null;
  thumbRenderer: WebGLRenderer | null;
  latestStages: ProcessingStageContribution[];
  // Every stage draw the window has said finished on this machine, for a renderer
  // made after the setStages that said so.
  confirmedDraws: Set<string>;
  latestPipeline: ResolvedPipeline;
  // Generic param bag for extension-contributed stage uniforms. Persisted so a
  // newly-created thumb renderer inherits it; the renderer keeps its own copy.
  latestParamBag: Record<string, unknown>;
  // Stage textures (e.g. baked LUT atlases), keyed by qualified key. Persisted so a
  // newly-created thumb renderer inherits them.
  latestStageTextures: Record<string, StageTextureData>;
  // The monitor's profile (Linux). Only the develop renderer, whose frames go to
  // the screen, ever holds it; thumbnails are stored and must stay sRGB.
  latestMonitorTransform: MonitorTransform | null;
  // The space the screen shows (P3 on a wide-gamut display). Like the monitor
  // transform, only the develop renderer takes it.
  latestDisplaySpace: DisplaySpace;
  // The soft proof's space, likewise the develop renderer's alone.
  latestProof: ColorSpaceId | null;
  // The last params pushed to the develop renderer. A `capture` swaps in override
  // params, renders, then restores these so a later display render (e.g. from a
  // viewport or clipping change that doesn't re-send params) isn't left showing
  // the captured frame's look. Kept while the renderer is null too, so one made by
  // an init retry starts from it instead of waiting for a re-post that may not come.
  lastParams: DevelopParams | null;
  // What the stages derive from lastParams, sent with them from the window.
  lastDerived: Record<string, unknown>;
  // Set by clearSource, cleared once the develop renderer is handed the next
  // photo's source.
  awaitingSource: boolean;
  // Set by each capture, cleared by each live render. The histogram and Upright
  // redraw with the uniforms and program the last render bound, and restoring a
  // capture's params, bag and pipeline only puts back what the next render binds,
  // so until one runs they would measure the capture (a gain map, a "before").
  liveStateStale: boolean;
  // The number of the develop renderer's source, carried by every frame: moved on by each
  // setImage and each main uploadSource that binds, sent while there is a renderer or not,
  // and by each bindSource hit. RenderBridge.sourceGen counts the same messages, so the
  // two agree on which source a number names.
  sourceGen: number;
  // Mirrors the gpuSourceCacheBytes preference. The develop renderer gets the full
  // budget (full-res sources are large); the thumb renderer caches tiny sources, so
  // a quarter holds many. 0 until the first setCacheBudget message.
  cacheBudgetBytes: number;
}

export function initialState(): WorkerState {
  return {
    canvas: null,
    renderer: null,
    thumbCanvas: null,
    thumbRenderer: null,
    latestStages: [],
    confirmedDraws: new Set(),
    latestPipeline: BUILTIN_RESOLVED,
    latestParamBag: {},
    latestStageTextures: {},
    latestMonitorTransform: null,
    latestDisplaySpace: "srgb",
    latestProof: null,
    lastParams: null,
    lastDerived: {},
    awaitingSource: false,
    liveStateStale: false,
    sourceGen: 0,
    cacheBudgetBytes: 0,
  };
}

export interface WorkerContext {
  state: WorkerState;
  respond(msg: WorkerResponse, transfer?: Transferable[]): void;
  /** Hands `target` a param bag: the worker's one way of setting one. */
  setBag(target: WebGLRenderer, bag: Record<string, unknown>): void;
}

export type Cmd = WorkerRequest["cmd"];
export type Handler<K extends Cmd> = (msg: Extract<WorkerRequest, { cmd: K }>) => void;
/** A handler for each of `K`. */
export type HandlersFor<K extends Cmd> = { [P in K]: Handler<P> };

// Fraction of the develop cache budget granted to the thumb renderer (its sources
// are downscaled, so a quarter holds many).
export const THUMB_CACHE_FRACTION = 0.25;

export const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Forward the develop renderer's downscaled source to the window, whose
// searches of it run there (source-pixels.ts keeps a separate module instance
// in each).
export function postSourcePixels(ctx: WorkerContext): void {
  const { renderer, sourceGen } = ctx.state;
  if (!renderer) return;
  const hs = renderer.sourcePixelsData();
  if (hs) ctx.respond({ type: "sourcePixels", sourceGen, data: hs.data, width: hs.w, height: hs.h }, [hs.data.buffer]);
}

// The develop renderer let go of the source it held before it failed to take this one, so
// nothing is drawn until the next source, and the view is told which one failed.
export function sourceFailed(ctx: WorkerContext, err: unknown): void {
  ctx.state.awaitingSource = true;
  ctx.respond({ type: "sourceError", sourceGen: ctx.state.sourceGen, message: messageOf(err) });
}

// Draws the live view, kept on the canvas rather than sent, when a capture
// drew last: a readback that redraws what the last render bound measures it.
export function bindLiveView(ctx: WorkerContext, target: WebGLRenderer): void {
  if (!ctx.state.liveStateStale) return;
  target.render();
  ctx.state.liveStateStale = false;
}

// Has `target` draw as the screen shows, or with `shown` false sRGB and unproofed.
export function showScreen(state: WorkerState, target: WebGLRenderer, shown: boolean): void {
  target.setMonitorTransform(shown ? state.latestMonitorTransform : null);
  target.setDisplaySpace(shown ? state.latestDisplaySpace : "srgb");
  target.setProofSpace(shown ? state.latestProof : null);
}

// What a renderer tells the window of each extension stage it quarantines.
export function reportQuarantine(ctx: WorkerContext): (stage: QuarantinedStage) => void {
  return (stage) => ctx.respond({ type: "stageQuarantined", ...stage });
}

// What a renderer tells the window of each program build with extension stages.
export function reportStageBuilds(ctx: WorkerContext): (event: StageBuildEvent) => void {
  return (event) => ctx.respond({ type: "stageBuild", ...event });
}

// Builds the program a new renderer's first frame needs. An extension stage that
// can't be built is quarantined by the renderer, which draws without it. What is
// left failing (a program that can't be built without any of them) fails frames,
// not the renderer, and only until it changes: that is logged once and the renderer
// stays. A stock program (the built-in transform with Safelight's own stages) that
// can't be built either means this machine can't run Safelight's own shader, so
// that throws: init answers it with initError for the bridge to retry and report,
// a thumbnail request with thumbnailError.
export function warmUp(target: WebGLRenderer, processVersion: number): void {
  try {
    target.prepareProgram(processVersion);
  } catch (err) {
    target.prepareStockProgram(processVersion);
    console.error(
      "[render-worker] stages or display transform can't be built; frames fail until they change:",
      err,
    );
  }
}
