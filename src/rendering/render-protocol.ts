// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The messages between the main thread (render-bridge.ts) and the render worker
// (render-worker.ts). Types only: both sides import this, neither the other.

import type { CropRect, DevelopParams, Mask } from "@/catalog/types";
import type { BrushTipContribution, ProcessingStageContribution, StageSpace, StageTextureData } from "@/extensions/types";
import type { ResolvedPipeline } from "@/rendering/webgl/resolved-pipeline";
import type { ProbePoint, QuarantinedStage, StageBuildEvent } from "./webgl/renderer";
import type { CapturePoint, FloatFrame } from "./float-frame";
import type { Float16Source, SourceSample, StoredSample } from "./source-sample";
import type { HistogramData } from "./histogram";
import type { MonitorTransform } from "./display-profile";
import type { ColorSpaceId, DisplaySpace } from "./color-space";

/** The developed frame of the whole image, untransformed and uncropped, as
 *  RGBA8 rows from the top. */
export interface DevelopedPixels {
  data: Uint8Array;
  width: number;
  height: number;
}

/** A decoded source on its way to a renderer: float pixels, a half-float preview
 *  with its sample, or a bitmap. */
export type SourceImage =
  | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean; baselineExposure?: number; baselineShadows?: number }
  | Float16Source
  | { kind: "bitmap"; bitmap: ImageBitmap };

/** What a thumbnail render takes whether its source is sent with it or already
 *  resident in the thumb renderer. */
export interface ThumbRenderBase {
  requestId: string;
  params: DevelopParams;
  asShotTemperature: number;
  maxEdge: number;
  // Per-render extension-stage params. When present, applied to the thumb
  // renderer for THIS render only (then the global bag is restored), so a
  // headless/batch render of a photo other than the live develop one uses its
  // OWN stage params instead of the active photo's.
  contributedParams?: Record<string, unknown>;
  // A grid preview of an edit. It is drawn as the live view draws the photo,
  // without the stages at rest on it (dormantWhen), so it can differ from the
  // full program's frame by a half-float step. Any other frame gets every stage.
  preview?: boolean;
}

/** A thumbnail render's output options on top of ThumbRenderBase. */
export interface ThumbEncodeOptions extends ThumbRenderBase {
  quality?: number;
  // A PNG rather than a JPEG, for a frame whose channel bytes carry data.
  lossless?: boolean;
}

/** One thumbnail render, from the thumb renderer's resident source under `key` or
 *  from `image`, which it doesn't keep. Exclusive: given both, `key` would win and
 *  the image be cloned into a post that ignores it. */
export type ThumbRequest = ThumbRenderBase & ({ key: string; image?: never } | { image: SourceImage; key?: never });

/** One of the live masks, in order: a mask the worker holds none of comes whole;
 *  one it holds by that id comes as its fields that are new or not the same value
 *  (`set`) and the keys it dropped (`remove`), both empty when it didn't change. */
export type MaskPatch = { mask: Mask } | { id: string; set: Partial<Mask>; remove: string[] };

export type WorkerRequest =
  | { cmd: "init"; width: number; height: number; highBitDepth: boolean }
  | {
      cmd: "setImage";
      image: SourceImage;
      maxEdge?: number;
      isFallbackPreview?: boolean;
    }
  // The develop view moved to another photo. Until that photo's source is set,
  // uploaded and bound, or bound from the cache, renders are answered frameSkipped
  // and histograms not at all: the bound source still belongs to the previous photo.
  | { cmd: "clearSource" }
  // `derived`: what the official and core stages derive from these params
  // (stage-derive.ts), worked out in the window where their code runs.
  | { cmd: "setParams"; params: DevelopParams; derived: Record<string, unknown> }
  // What differs from the params the bridge last posted, whole or by patches: `set` holds
  // the top-level fields that are new or not the same value, `remove` the keys dropped.
  // Every DevelopParams field is required, so only keys a stored edit carries beyond them
  // can be. Never sent before whole params, nor first after an init. `derived` likewise
  // holds the derived values that are new or not the same value, `derivedRemove` the
  // keys of those dropped. Changed masks come as `masks` rather than in `set` while
  // every mask id names one mask, so the worker keeps the masks it holds that didn't
  // change, and their brush dabs, as the objects the renderer already signed.
  | {
      cmd: "patchParams";
      set: Partial<DevelopParams>;
      remove: string[];
      masks?: MaskPatch[];
      derived?: Record<string, unknown>;
      derivedRemove?: string[];
    }
  | { cmd: "setDerived"; derived: Record<string, unknown> }
  | { cmd: "setContributedParams"; bag: Record<string, unknown> }
  // What differs from the bag the bridge last posted, whole or by patches: `set` holds
  // the new and changed entries, `remove` the dropped keys (none of them in `set`).
  // Values are untyped like the bag's: extensions define them at runtime.
  | { cmd: "patchContributedParams"; set: Record<string, unknown>; remove: string[] }
  | { cmd: "setStageTextures"; bag: Record<string, StageTextureData> }
  // The stage textures set (`set`) and cleared (`remove`, none of them in `set`) since
  // the bag the bridge last posted, whole or by patches.
  | { cmd: "patchStageTextures"; set: Record<string, StageTextureData>; remove: string[] }
  // The brush tips the bakes stamp with, whole each time: the set the window holds,
  // which replaces the worker's. Every renderer in the worker reads it as one.
  | { cmd: "setBrushTips"; tips: Record<string, BrushTipContribution> }
  // Render one frame with `params` to an ImageBitmap returned out-of-band (NOT
  // blitted to the display) so an extension can grab a "before" frame at the
  // current source + viewport without disturbing the live view. The live params
  // and pipeline are restored afterwards. See render-bridge.capture().
  // `asShown`: the frame as the screen shows it, through the display profile and
  // the soft proof, with the view's overlays (clipping warning, mask tint,
  // sharpening preview).
  | {
      cmd: "capture";
      reqId: number;
      params: DevelopParams;
      derived: Record<string, unknown>;
      pipeline: ResolvedPipeline;
      asShown?: boolean;
      /** Merged over the live bag for this capture only (an extension's
       *  auxiliary render: a gain map, a mask). */
      bagPatch?: Record<string, unknown>;
    }
  // A capture as floats, for measuring (see render-bridge.captureFloat): read
  // at most `maxEdge` px on its long edge, at `point` and in `space`, which the
  // renderer converts it into on the GPU.
  | {
      cmd: "captureFloat";
      reqId: number;
      params: DevelopParams;
      derived: Record<string, unknown>;
      pipeline: ResolvedPipeline;
      point: CapturePoint;
      space: StageSpace;
      maxEdge: number;
      bagPatch?: Record<string, unknown>;
    }
  // The native-resolution centre of the bound source, a live decode's or the one
  // its cache entry kept (source-sample.ts), for an extension measuring the
  // sensor's own pixels. See render-bridge.readSourceSample.
  | { cmd: "readSourceSample"; reqId: number }
  // A resident cached source's RAW cache entry was rewritten with its decoded
  // size and centre sample (cache-events.ts). The develop renderer takes them
  // in place; the thumbnail renderer keeps no samples. No reply.
  | { cmd: "setSourceSample"; key: string; fullWidth: number; fullHeight: number; sample: StoredSample }
  // The linear colour around (u, v) of the live frame, x right and y down in
  // [0, 1] across its buffer, drawn from what the worker holds when it arrives.
  // See WebGLRenderer.probe.
  | { cmd: "probe"; reqId: number; u: number; v: number; point: ProbePoint }
  | { cmd: "setAsShotTemperature"; kelvin: number }
  // Answered exactly once, by `seq`: with a frame, frameSkipped or renderError. The
  // bridge sends the next render only once this one is answered.
  | { cmd: "render"; seq: number; wantHistogram?: boolean; wantExtended?: boolean }
  | ({
      cmd: "renderThumbnail";
      image: SourceImage;
      derived: Record<string, unknown>;
      // The rendered photo's display transform, resolved on the main thread
      // (the worker has no registry). Applied for THIS render only.
      pipeline: ResolvedPipeline;
      // Read the frame as floats at this point, converted into this space, and
      // answer thumbnailFloat instead of encoding a blob (renderPhotoFloatFrame).
      float?: Pick<FloatFrame, "point" | "space">;
    } & ThumbEncodeOptions)
  | { cmd: "setShowClipping"; mode: number }
  | { cmd: "setOutsideColor"; rgb: [number, number, number] }
  | { cmd: "setMonitorTransform"; transform: MonitorTransform | null }
  | { cmd: "setDisplaySpace"; space: DisplaySpace }
  // The export space the live view soft proofs, or null for none.
  | { cmd: "setProof"; space: ColorSpaceId | null }
  | { cmd: "setMaskViz"; index: number; color: [number, number, number]; strength: number }
  | { cmd: "setSharpenViz"; mode: number }
  | { cmd: "computeHistogram"; wantExtended?: boolean }
  // With the draws of those stages that finished on this machine before, as
  // "key|cost" (confirmedDrawsOf), which the renderers then don't wait on.
  | { cmd: "setStages"; stages: ProcessingStageContribution[]; confirmedDraws?: string[] }
  // The stages the window expects the photo to need soon (a panel opened or hovered,
  // a control focused): the develop renderer starts building the program that wakes
  // those of them that are dormant (ProcessingStageContribution.dormantWhen).
  | { cmd: "prewarmStages"; stageIds: string[] }
  | { cmd: "setPipeline"; pipeline: ResolvedPipeline }
  | { cmd: "readDevelopedPixels"; reqId: number; edge: number }
  // ── GPU source cache ──
  | { cmd: "bindSource"; reqId: number; key: string }
  | {
      cmd: "uploadSource";
      target: "main" | "thumb";
      key: string;
      image: SourceImage;
      maxEdge?: number;
      isFallbackPreview?: boolean;
      bind?: boolean;
    }
  | { cmd: "hasSource"; reqId: number; target: "main" | "thumb"; key: string }
  | { cmd: "setCacheBudget"; bytes: number }
  | { cmd: "setViewport"; roi: { x: number; y: number; w: number; h: number } | null; outW?: number; outH?: number }
  | ({
      cmd: "renderThumbnailFromSource";
      key: string;
      derived: Record<string, unknown>;
      // See renderThumbnail.pipeline.
      pipeline: ResolvedPipeline;
      // See renderThumbnail.float.
      float?: Pick<FloatFrame, "point" | "space">;
    } & ThumbEncodeOptions);

export type WorkerResponse =
  | { type: "ready"; pipelineFloat: boolean }
  // The develop renderer could not be created (no WebGL2 context). The bridge
  // retries init on a schedule; see RenderBridge's availability.
  | { type: "initError"; message: string }
  // The develop canvas's graphics context was lost (a GPU reset), and the renderer with
  // it. Once the context is restored the worker builds the renderer again, as the last
  // init did, and answers that like an init: ready, or initError. It holds no source then.
  | { type: "contextLost" }
  | {
      type: "frame";
      seq: number;
      bitmap: ImageBitmap;
      width: number;
      height: number;
      // The source it was drawn from: its size as the renderer holds it (after the upload
      // cap, 0 before any), and its number, which moves on each time the develop renderer
      // is handed a source (see sourceGen below).
      sourceWidth: number;
      sourceHeight: number;
      sourceGen: number;
      // The decoded frame's size before the upload cap, and whether
      // readSourceSample has a sample of the source: a live float decode, or a
      // cached preview stored with one. Absent on a frame from an older worker build.
      sourceFullWidth?: number;
      sourceFullHeight?: number;
      sourceNative?: boolean;
      // The window of the image it was drawn for (setViewport); null or absent, the
      // whole image.
      roi?: { x: number; y: number; w: number; h: number } | null;
      // The size a frame of the whole image would have now, which a window's frame
      // is part of: the view places the window by it. Absent, unknown.
      wholeWidth?: number;
      wholeHeight?: number;
      // The region of the transformed image it is of: the crop it was drawn with,
      // which crop mode widens to the whole image. Its window is part of this.
      // Absent, unknown.
      crop?: CropRect;
      histogram?: HistogramData;
      // Set when the frame asked for a histogram and it is posted on its own after the
      // frame (or after the follow-up frame of a pending prepass), so the frame itself
      // never waits for the readback.
      histogramFollows?: boolean;
      // The prepass stages this frame was drawn without (no texture unit was left
      // for their result); absent when it ran every stage that was on.
      overflowedStages?: string[];
      // Set when the frame put off mask copies' prepasses: another render of the
      // same state draws them.
      prepassPending?: boolean;
    }
  // Render `seq` had nothing to draw with or from: no renderer, or no source yet for
  // the photo the develop view moved to.
  | { type: "frameSkipped"; seq: number }
  // Drawing render `seq`, or measuring the histogram it asked for, threw.
  | { type: "renderError"; seq: number; message: string }
  // The develop renderer couldn't take source `sourceGen` (see sourceGen below). It holds
  // no picture of the photo then, so renders are answered frameSkipped until the next.
  | { type: "sourceError"; sourceGen: number; message: string }
  | { type: "histogram"; histogram: HistogramData }
  // The histogram a frame asked for (histogramFollows) threw after the frame was posted.
  | { type: "histogramError"; message: string }
  | { type: "thumbnail"; requestId: string; blob: Blob }
  // A thumbnail asked for as floats. null: no float render targets.
  | { type: "thumbnailFloat"; requestId: string; frame: FloatFrame | null }
  | { type: "thumbnailMiss"; requestId: string; key: string }
  // A thumbnail render failed (threw, or convertToBlob rejected). Carries the
  // requestId so the bridge can settle THAT pending promise — without this a
  // failure falls through to the generic "error" response, which isn't tied to a
  // request, so renderThumbnailAsync hangs forever and wedges the caller.
  | { type: "thumbnailError"; requestId: string; message: string }
  | { type: "sourceBound"; reqId: number; hit: boolean }
  | { type: "captured"; reqId: number; bitmap: ImageBitmap }
  // null: no renderer, no source, no float render targets, or the draw threw.
  | { type: "capturedFloat"; reqId: number; frame: FloatFrame | null }
  // null: no renderer, no source yet for the photo the view moved to, or a
  // source with no sample (a bitmap, the camera preview, a cache entry written
  // before the sample was kept).
  | { type: "sourceSample"; reqId: number; sample: SourceSample | null }
  // null: no renderer, no source, no float render targets, or the probe threw.
  | { type: "probed"; reqId: number; rgb: [number, number, number] | null }
  | { type: "hasSource"; reqId: number; has: boolean }
  | { type: "developedPixels"; reqId: number; pixels: DevelopedPixels | null }
  // A read of the developed pixels threw. Carries the reqId so the bridge settles
  // THAT pending read; the reqId-less generic "error" would leave it hanging.
  | { type: "developedPixelsError"; reqId: number; message: string }
  // The downscaled 8-bit source, forwarded so the window's searches of it
  // (source-pixels.ts) have pixels.
  // `sourceGen` is the source's number, as frames carry it.
  | { type: "sourcePixels"; sourceGen: number; data: Uint8ClampedArray; width: number; height: number }
  // A renderer left an extension stage out of its programs, which couldn't be built
  // with it, and draws without it until it is registered again changed. Once per
  // stage, signature and process version, and renderer.
  | ({ type: "stageQuarantined" } & QuarantinedStage)
  // A renderer started or ended building a program with these extension stages
  // in it: the window's crash guard pins a lost context on a build in hand.
  | ({ type: "stageBuild" } & StageBuildEvent)
  | { type: "error"; message: string };
