// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { CropRect, DevelopParams, Mask } from "@/catalog/types";
import { CURRENT_PROCESS_VERSION, MAX_BRUSH_MASKS } from "@/catalog/types";
import type { HistogramData } from "../histogram";
import { geometryKeys, imageGeometry, regionOutputSize, type GeometryKeys } from "../geometry";
import { bindUniformByType, boundValue, imageSpaceValue } from "./uniform-values";
import {
  shaderVariantFor,
  variantKey,
  V2_VARIANT,
  type ProcessVersion,
  type ProgramExit,
  type ShaderVariant,
} from "./shaders";
import { BUILTIN_DENOISE_ID } from "./builtin-denoise";
import { isBuiltInStage, writesRawNames } from "./builtin-stage";
import {
  EXPORT_TARGETS,
  drawExport,
  type ExportFramebuffer,
  type ExportPixels,
  type ExportPixelsOptions,
  type Sharpen,
} from "./export-draw";
import { created, drainErrors, ranOutOfMemory, readCaps, setSampling, type Caps } from "./gl-resources";
import {
  FILL_EDGE,
  SourceCache,
  capDrawableToEdge,
  capFloatToEdge,
  createSourceTexture,
  downsampleDrawable,
  uploadFloatMips,
} from "./source-cache";
import { PatchedSource } from "./patched-source";
import { PrepassRunner, type PrepassFrame } from "./prepass-runner";
import {
  ATTR_POS,
  ATTR_UV,
  ProgramCache,
  createProgram,
  isolateFailingStages,
  type FailingStage,
  type PipelineProgram,
} from "./program-cache";
import {
  PROBE_PX,
  Readback,
  downscaledSize,
  emptyHistogram,
  probeMean,
  probePatch,
  topDown,
} from "./readback";
import { maskInstances, type MaskInstances } from "./mask-stage-instances";
import {
  RESULT_ARRAY_UNIFORM,
  buildStageInjection,
  stageSignature,
  type BuiltStageInjection,
  type ContributedBinding,
  type MaskSlotBinding,
  type PrepassStage,
  type StageSplit,
  type StageTextureBinding,
} from "./stage-injection";
import { SplitTokens } from "./split-signature";
import { clippingBits, toneShoulderOn } from "./variant-decisions";
import {
  DEVELOP_SAMPLERS,
  MAX_STAGE_TEXTURES,
  PHOTO_TEX_UNITS,
  STAGE_TEX_UNIT_BASE,
  prepassUnits,
} from "./prepass-units";
import { isUniformValue } from "@/extensions/pipeline-validation";
import type {
  ProcessingStageContribution,
  StageSpace,
  StageTextureData,
} from "@/extensions/types";
import { coverageItemsFromBag } from "./stage-coverage";
import {
  OUT_SPACE_CODE,
  outMatrixColumnMajor,
  type ColorSpaceId,
  type DisplaySpace,
} from "../color-space";
import { DISPLAY_CURVE_CODE, type MonitorTransform } from "../display-profile";
import { lmsUniforms, proofUniforms } from "../output-map";
import { decodePerceptual, isIdentitySpace } from "../stage-space";
import { DEFAULT_CAPTURE_SPACE, measureSize, type CapturePoint } from "../float-frame";
import type { ResolvedPipeline } from "@/rendering/webgl/resolved-pipeline";
import { BUILTIN_RESOLVED } from "./builtin-pipeline";
import {
  CoverageBaker,
  CoverageInputs,
  bakeCoverage,
  coverageSignature,
  type CoverageItem,
} from "./mask-coverage";
import { sourcePixelsFromLinear } from "../source-pixels";
import { halfToFloat32 } from "@/raw/half-float";
import {
  cutSourceSample,
  unpackSourceSample,
  type Float16Source,
  type SourceSample,
  type StoredSample,
} from "@/rendering/source-sample";

type StageSet = ProcessingStageContribution[] | Record<string, ProcessingStageContribution>;
const NO_STAGES: StageSet = [];

/** What the stages derive from a frame of `params` (stage-derive.ts). */
export type StageDerive = (
  params: DevelopParams,
  stages: readonly ProcessingStageContribution[],
) => Record<string, unknown>;

// Where a develop draw lands: a framebuffer (null for the canvas) and its size.
interface DrawTarget {
  fbo: WebGLFramebuffer | null;
  w: number;
  h: number;
}

/** Where probe() reads: the colour the output stage receives, or the
 *  scene-linear colour the mask components compare. */
export type ProbePoint = "output" | "mask";

// What a probe draws: its patch of the image, in setViewport's terms.
interface ProbeDraw {
  roi: { x: number; y: number; w: number; h: number };
  point: ProbePoint;
}

// A frame drawn away from the canvas: a probe's patch, a measurement, or,
// with neither, captureFloatFrame's frame as the screen would show it. A
// measurement (an export frame, a float capture) has neither the view's
// overlays nor the screen's space; "pre-output" draws `c` as the output stage
// receives it, which output sharpening and float captures read.
interface Redirect extends DrawTarget {
  probe?: ProbeDraw;
  measure?: CapturePoint;
}

// Default cap on render resolution for interactive performance. Export passes
// a larger value (or the image's own long edge) to render at full size.
const MAX_EDGE = 2560;

// The bindings of a transform that declares none: one list, so the split
// tokens, which compare the list by reference, see no change between frames.
const NO_TRANSFORM_BINDINGS: readonly ContributedBinding[] = [];

/** The unit each stage texture binds at: lut and dynamic textures from
 *  STAGE_TEX_UNIT_BASE (at most MAX_STAGE_TEXTURES of them), photo textures at
 *  PHOTO_TEX_UNITS and then right after the others. Coverage textures ride the
 *  brush atlas and take none. */
function stageTextureUnits(bindings: readonly StageTextureBinding[]): Map<string, number> {
  const units = new Map<string, number>();
  let next = STAGE_TEX_UNIT_BASE;
  for (const b of bindings) {
    if (b.kind === "coverage" || b.kind === "photo" || b.kind === "atlas") continue;
    if (next >= STAGE_TEX_UNIT_BASE + MAX_STAGE_TEXTURES) break;
    units.set(b.qualifiedKey, next++);
  }
  let photo = 0;
  for (const b of bindings) {
    if (b.kind !== "photo" && b.kind !== "atlas") continue;
    units.set(b.qualifiedKey, PHOTO_TEX_UNITS[photo++] ?? next++);
  }
  return units;
}

/** A bag value as an atlas texture's items: up to four brush strokes. */
function atlasItems(value: unknown): CoverageItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is CoverageItem => typeof v?.id === "string" && Array.isArray(v?.dabs))
    .slice(0, MAX_BRUSH_MASKS);
}

/** A bag value as a photo texture's data, or undefined when it isn't one. */
function photoTextureData(value: unknown): StageTextureData | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const t = value as Partial<StageTextureData>;
  const sized = Number.isInteger(t.width) && Number.isInteger(t.height) && (t.width ?? 0) > 0 && (t.height ?? 0) > 0;
  const typed = t.data instanceof Uint8Array || t.data instanceof Float32Array;
  return sized && typed && typeof t.format === "string" && typeof t.version === "number"
    ? (t as StageTextureData)
    : undefined;
}

export type RenderCanvas = HTMLCanvasElement | OffscreenCanvas;

/** An extension stage the develop program couldn't be built with, which the
 *  renderer now draws without until the stage is registered again changed. */
export interface QuarantinedStage {
  stageId: string;
  /** The stage's stageSignature when it failed. */
  signature: string;
  /** What the shortest build with it failed with: the shader or link log. */
  log: string;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface WebGLRendererOpts {
  /** Lets a version 1 photo's heal/clone copy be RGBA16 (EXT_texture_norm16). A version 2
   *  photo tries RGBA16F first whatever it says. Defaults to on, the Preferences default;
   *  window callers pass the Preferences value. */
  highBitDepth?: boolean;
  /** The processing stages, or a function read every frame for them, so a renderer
   *  that outlives a stage change follows it. A function returning the same object
   *  until the set changes (the registry's processingStages) keeps the stage
   *  injection built. Defaults to none; setStages replaces either. */
  stages?: ProcessingStageContribution[] | (() => StageSet);
  /** The display transform. Defaults to the built-in; setActivePipeline swaps it. */
  pipeline?: ResolvedPipeline;
  /** What setParams derives a frame's values with when it is handed none: the
   *  window's (window-derive.ts) for a renderer in the window. Without it every
   *  setParams must be handed them, as the render worker's is. */
  derive?: StageDerive;
  /** The newest process version this renderer renders with. A photo stored
   *  newer renders as it. Defaults to CURRENT_PROCESS_VERSION; tests pass a
   *  later version to build its programs before it ships. */
  processVersionCap?: ProcessVersion;
  /** How many mask copies' prepasses a frame drawn to the canvas may run; the
   *  rest run on the frames after it (prepassPending). Defaults to no limit,
   *  which exports and thumbnails need: they draw one frame. A redirected
   *  frame (a capture or a probe) is never limited. */
  maskCopyPrepassesPerFrame?: number;
  /** Told of each extension stage the renderer quarantines: once per stage,
   *  signature and process version. */
  onStageQuarantined?: (stage: QuarantinedStage) => void;
}

export class WebGLRenderer {
  private canvas: RenderCanvas;
  private gl: WebGL2RenderingContext;
  // The program syncPipeline() last selected, so null until the first frame.
  // Nothing is built when the renderer is: which process version's program it
  // needs depends on the photos it is handed. prepareProgram builds one ahead on
  // request, into the program cache; it doesn't select it.
  private program: WebGLProgram | null = null;
  private imageTexture: WebGLTexture;
  private maskTexture: WebGLTexture;
  private maskSig = "";
  private maskChannelOf: Record<string, number> = {};
  private maskInputs = new CoverageInputs();
  private readonly maskBaker = new CoverageBaker();
  // The patched copy of the source a retouched frame develops from (patched-source.ts).
  private readonly patchedSource: PatchedSource;
  // Downscaled 8-bit sRGB copy of the source, which the owner of a renderer that
  // keeps it forwards to the window for the searches extensions run there
  // (source-pixels.ts).
  private healSig = "";
  private fillSrc: Uint8ClampedArray | null = null;
  private fillW = 0;
  private fillH = 0;
  // What this context renders and holds, read once at construction.
  private readonly caps: Caps;
  // The histogram, downscale, float-capture and export read-backs.
  private readonly readback: Readback;
  // When set, render()'s final composite pass draws into this target instead of
  // the (8-bit) canvas: the whole frame for a 16-bit export (captureFloatFrame,
  // exportPixels) or a float capture (readFloatFrame), or `c` for output
  // sharpening, at either depth; or for probe() just its patch, which replaces
  // the live window.
  private redirect: Redirect | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  // Extension-contributed stage uniforms (namespaced) and their live values.
  // Bindings are rebuilt whenever the stage set changes; values arrive via
  // setContributedParams (the develop store's generic param bag).
  private contributedBindings: ContributedBinding[] = [];
  private contributedParams: Record<string, unknown> = {};
  // The live transform's bindings (ResolvedPipeline.bindings), taken from the
  // pipeline on every syncPipeline: a re-registration can change a default
  // without changing the program. A transform that fell back to the built-in
  // program has no locations for them, so render() skips them.
  private transformBindings: readonly ContributedBinding[] = [];
  // Mask copies of maskable stages (mask-stage-instances.ts) the frame's masks
  // call for, and the bag the stages read with the copies' values added. Both
  // are memoized on what they're made from: the split tokens compare bags by
  // reference.
  private copiesMemo: {
    source: unknown;
    masks: readonly Mask[];
    variant: ShaderVariant;
    copies: MaskInstances;
  } | null = null;
  private frameBagMemo: {
    params: Record<string, unknown>;
    derived: Record<string, unknown>;
    copies: Record<string, unknown>;
    bag: Record<string, unknown>;
  } | null = null;
  private maskSlotBindings: MaskSlotBinding[] = [];
  /** What the stages derive from the params (setParams). */
  private derivedValues: Record<string, unknown> = {};
  // The copies the program in use was built without: with them it failed.
  private droppedCopies: string[] = [];
  private readonly maskCopyPrepassesPerFrame: number;
  // The samplers MAX_TEXTURE_IMAGE_UNITS leaves the stages past the develop
  // shader's own; a version 2 set that would pass it shares one result array.
  private readonly samplerBudget: number;
  private warnedCoverageOverflow = new Set<string>();
  // What fell below float16 on this GPU, by path: the sentence naming what loses range.
  private reducedPrecisionNotes = new Map<"prepass" | "stage-results" | "developed-copy", string>();
  // Extension stage textures: namespaced sampler bindings (rebuilt with the stage
  // set), the latest pixel data per qualified key, and the GPU textures we've
  // uploaded (cached by version so an unchanged stock isn't re-uploaded).
  private stageTextureBindings: StageTextureBinding[] = [];
  private stageTextures: Record<string, StageTextureData> = {};
  private uploadedStageTex = new Map<string, { tex: WebGLTexture; version: number }>();
  /** The photo textures stages derive per frame (TextureRequirement "photo"),
   *  kept apart from the ones setStageTextures supplies. */
  private uploadedPhotoTex = new Map<string, { tex: WebGLTexture; version: number }>();
  /** The version of each stage texture last refused for exceeding the GPU's
   *  texture limit, so each version is reported once and not every frame. */
  private oversizedStageTex = new Map<string, number>();
  /** Each atlas texture's last bake (TextureRequirement "atlas"), redone when
   *  its items or the image's size change. */
  private atlases = new Map<string, { inputs: CoverageInputs; data: StageTextureData; sig: string }>();
  private atlasVersion = 0;
  private dummyStageTex: WebGLTexture | null = null;
  // The multi-pass prepass framework (prepass-runner.ts) and the stage set's prepass stages.
  private readonly prepass: PrepassRunner;
  private prepassStages: PrepassStage[] = [];
  // Whether the core NR block steps aside (uSkipCoreNR) for a stage that
  // replaces it, and whether it runs in place of a denoiser that can't, both
  // decided with the program in syncPipeline.
  private skipCoreNR = false;
  private coreNRStandsIn = false;
  // Tokens for the split part of a reads-current stage's prepass signature.
  private splitTokens = new SplitTokens();
  // Bumped whenever the active source texture is swapped (setImage / bindSource).
  private sourceEpoch = 0;
  private params: DevelopParams | null = null;
  private asShotTemperature = 6500;
  private showClipping = 0;
  // Display-space colour for out-of-image pixels (crop-mode margins). Defaults to
  // the legacy neutral dark; the develop view sets it to the canvas surround.
  private outsideColor: [number, number, number] = [0.04, 0.04, 0.04];
  // Coverage-visualization overlay: -1 = off, else the mask index to tint.
  private vizMask = -1;
  private vizColor: [number, number, number] = [0.9, 0.25, 0.25];
  private vizStrength = 0.5;
  // Sharpening preview mode (Alt/Ctrl-drag): 0 = off, 1 = masking, 2 = detail, 3 = luma.
  private sharpenViz = 0;
  private hasImage = false;
  private imageWidth = 0;
  private imageHeight = 0;
  // The decoded source's size before the upload cap: a RAW's frame as decoded,
  // a bitmap's own size, a cached preview's decoded frame size (its own size
  // for an entry stored without one). Passes read it as uSourceSize to scale a
  // radius given in source pixels to their texels.
  private sourceFullWidth = 0;
  private sourceFullHeight = 0;
  // The centre of a live float decode at native resolution, or the sample
  // stored with a cached preview (3.1.0 and later); null for a bitmap, the
  // camera preview, an older cache entry, and any source on a renderer that
  // keeps none (source-sample.ts).
  private sourceSample: StoredSample | null = null;
  /** Keep the native-resolution centre of each live float decode, and the sample
   *  a cached preview was stored with, for readSourceSample (source-sample.ts).
   *  Off by default: the thumb and export renderers never answer samples, and
   *  the cut of a live decode costs a 16 MB pass. */
  keepSourceSample = false;
  /** Keep the 8-bit search image of each source for sourcePixelsData. Off by
   *  default: only the live develop renderer's owner forwards it to the window,
   *  and the others would pay a downscale on every upload for nothing. */
  keepSourcePixels = false;
  private maxEdge = MAX_EDGE;
  // Output colour space. Live develop/thumbnails stay sRGB (a no-op in the
  // shader); export sets a wider space so the encode + ICC match.
  private outSpace: ColorSpaceId = "srgb";
  // The monitor's profile (Linux, Preferences ▸ Rendering), for the live view.
  private monitorTransform: MonitorTransform | null = null;
  // The screen's own space, for version 3 frames. A frame encodes for it only
  // when the canvas can be tagged to match; an untagged canvas is read as sRGB.
  private displaySpace: DisplaySpace = "srgb";
  // The export space a soft proof previews, or null with proofing off.
  private proofSpace: ColorSpaceId | null = null;
  private readonly canTagBuffer: boolean;
  private linear = false;
  private isFallbackPreview = false;
  private applyBaseCurve = false;
  // The source camera maker's exposure offset as a gain, which version 2 and
  // later apply with the refit baseline (uBaselineGain); 1 for anything else.
  private baselineGain = 1;
  // The camera match's shadows lift (Shadows slider units) for Active
  // D-Lighting and its kin, which version 2 and later apply with the camera
  // baseline, before the photo's own Shadows (uBaselineShadows); 0 for
  // anything else.
  private baselineShadows = 0;
  // Active render pipeline + stage signatures + process version + exit: compared
  // on every render to detect when another program is needed (pipeline change,
  // stage enable/disable, a photo on another process version, or a probe).
  private pipelineSig = "";
  private stageSig = "";
  private readonly newestVersion: ProcessVersion;
  private variant: ShaderVariant = V2_VARIANT;
  private programExit: ProgramExit | undefined;
  private pipelineSkipBase = false;
  private pipelineSkipShoulder = false;
  // The develop programs built so far (program-cache.ts).
  private readonly programs: ProgramCache;
  private vao: WebGLVertexArrayObject | null = null;
  private quadBuf: WebGLBuffer | null = null;
  private stageSource: () => StageSet = () => NO_STAGES;
  // The stages that patch the source and the last text of each one's values (patchOf).
  private patchMemo: {
    source: StageSet;
    stages: readonly ProcessingStageContribution[];
    sigs: Map<string, { values: unknown[]; sig: string }>;
  } | null = null;
  private pipeline: ResolvedPipeline = BUILTIN_RESOLVED;
  private derive: StageDerive | null = null;
  // syncPipeline runs every frame. Rebuilding the injection re-namespaces every
  // stage's GLSL, so it happens only when the stage source changes: the registry
  // replaces its processingStages object on every change, and setStages drops
  // the memo, so an injected array edited in place is rebuilt too. Each process
  // version and set of mask copies keeps its own build, so photos alternating
  // between them reuse each.
  private injectionMemo: {
    source: readonly ProcessingStageContribution[] | Record<string, ProcessingStageContribution>;
    built: Map<string, BuiltStageInjection>;
  } | null = null;
  // Extension stages a process version's develop program couldn't be built with,
  // by id, as "signature|variant": left out of that version's programs for the
  // renderer's life. Registered again with anything changed, a stage signs anew
  // and is tried again.
  private readonly quarantined = new Map<string, Set<string>>();
  // The ids of the stage set the last stage was quarantined from.
  private quarantinedFrom: ReadonlySet<string> = new Set();
  private readonly onStageQuarantined: ((stage: QuarantinedStage) => void) | undefined;

  // The GPU-resident source cache (source-cache.ts).
  private readonly sources: SourceCache;
  // True while this.imageTexture is owned by the renderer (legacy setImage path)
  // rather than the cache. A cache-owned texture must not be deleted on the next
  // load or on dispose — the cache owns its lifetime.
  private imageTextureOwned = true;
  // Viewport window into the displayed image (null = whole frame). When set, the
  // output canvas is sized to roiOut and only the window is rendered at that
  // resolution (crisp zoom). See setViewport.
  private roi: { x: number; y: number; w: number; h: number } | null = null;
  private roiOut: { w: number; h: number } | null = null;

  constructor(canvas: RenderCanvas, opts?: WebGLRendererOpts) {
    const gl = canvas.getContext("webgl2", {
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    }) as WebGL2RenderingContext | null;
    if (!gl) {
      throw new Error("WebGL2 not supported");
    }
    this.canvas = canvas;
    this.gl = gl;
    this.canTagBuffer = "drawingBufferColorSpace" in gl;
    const stages = opts?.stages;
    if (stages) this.stageSource = typeof stages === "function" ? stages : () => stages;
    if (opts?.pipeline) this.pipeline = opts.pipeline;
    if (opts?.derive) this.derive = opts.derive;
    this.newestVersion = opts?.processVersionCap ?? CURRENT_PROCESS_VERSION;
    this.maskCopyPrepassesPerFrame = opts?.maskCopyPrepassesPerFrame ?? Infinity;
    this.onStageQuarantined = opts?.onStageQuarantined;

    const caps = readCaps(gl, { norm16: opts?.highBitDepth ?? true });
    this.caps = caps;
    this.patchedSource = new PatchedSource(gl, caps, (note) => {
      if (note) this.noteReducedPrecision("developed-copy", note);
      else this.reducedPrecisionNotes.delete("developed-copy");
    });
    this.samplerBudget = caps.textureUnits - DEVELOP_SAMPLERS;
    this.sources = new SourceCache(gl);
    this.programs = new ProgramCache(gl);
    this.readback = new Readback(gl, caps.colorBufferFloat, (vs, fs) => createProgram(gl, vs, fs));
    this.prepass = new PrepassRunner(gl, caps.colorBufferFloat, {
      drawSplit: (index, srcTex, applyRetouch, target) => this.drawSplit(index, srcTex, applyRetouch, target),
      note: (path, note) => this.noteReducedPrecision(path, note),
    });

    this.setupQuad();

    this.imageTexture = createSourceTexture(gl);
    this.maskTexture = created(gl.createTexture());
    this.initCoverageTexture(this.maskTexture);
  }

  // Whether float colour buffers are renderable (EXT_color_buffer_float). This one
  // flag governs the entire pipeline's working precision: when false, every
  // intermediate (ping-pong targets, histogram readback) is RGBA8, so even a
  // 16-bit source is crushed to 8 bits at the first pass and any tonal stretch
  // bands. Surfaced to the UI as a diagnostic.
  get colorBufferFloat(): boolean {
    return this.caps.colorBufferFloat;
  }

  /** The intermediates that fell below float16 on this GPU, each as a sentence naming
   *  what loses range. Empty while everything runs at full precision. */
  reducedPrecision(): string[] {
    return [...this.reducedPrecisionNotes.values()];
  }

  // Warns when a path first falls back, or falls back further; a path already at that note stays quiet.
  private noteReducedPrecision(
    path: "prepass" | "stage-results" | "developed-copy",
    note: string,
  ): void {
    if (this.reducedPrecisionNotes.get(path) === note) return;
    this.reducedPrecisionNotes.set(path, note);
    console.warn(`[render] ${note}`);
  }

  /** Cumulative split and pass draws since construction. */
  get renderDrawCounts(): { readonly split: number; readonly pass: number } {
    return this.prepass.drawCounts;
  }

  /** The stages the last frame was drawn without: prepass stages that were
   *  active but had no texture unit left for their result (their inline glsl
   *  read another's), and mask copies a program couldn't be built with. */
  get overflowedStages(): readonly string[] {
    const overflowed = this.prepass.overflowedStages;
    return this.droppedCopies.length > 0 ? [...overflowed, ...this.droppedCopies] : overflowed;
  }

  /** Whether the last frame put off a mask copy's prepass (maskCopyPrepassesPerFrame):
   *  another frame of the same params finishes it. */
  get prepassPending(): boolean {
    return this.prepass.copiesPutOff;
  }

  // 1x1 transparent default so a coverage sampler is always valid even with no
  // brush items present.
  private initCoverageTexture(tex: WebGLTexture) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    setSampling(gl, gl.TEXTURE_2D, gl.LINEAR);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0]),
    );
  }

  // Rebuild a coverage atlas when its geometry changes. Cheap no-op on a
  // signature match or when there are no brush items. Returns the channel map.
  private updateCoverageTexture(
    tex: WebGLTexture,
    items: CoverageItem[],
    prevSig: string,
  ): { sig: string; channelOf: Record<string, number> } {
    const aspect = this.imageHeight > 0 ? this.imageWidth / this.imageHeight : 1;
    const sig = coverageSignature(items, aspect);
    if (sig === prevSig) return { sig, channelOf: this.maskChannelOf };
    const baked = this.maskBaker.bake(items, aspect);
    const gl = this.gl;
    // With no channel mapped, the texture still holds the empty pixel it was
    // created or last cleared with.
    if (!baked && Object.keys(this.maskChannelOf).length === 0) return { sig, channelOf: {} };
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (!baked) {
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 0]),
      );
      return { sig, channelOf: {} };
    }
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, baked.size, baked.size, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, baked.data,
    );
    return { sig, channelOf: baked.channelOf };
  }

  // Brush coverage comes from brush COMPONENTS across all masks plus the
  // coverage-kind textures extension stages paint into the bag; the atlas packs
  // up to four into RGBA, the photo's own brushes first. Keyed by component id
  // or qualified texture key. Signing the dabs is skipped unless a dab array or
  // bag value was replaced, so callers replace them rather than editing them.
  // A bake that throws is tried again by the next call, whatever changed.
  private updateMaskTexture(masks: Mask[]) {
    const keys = this.coverageKeys();
    const brushes: CoverageItem[] = [];
    for (const m of masks) {
      for (const c of m.components) {
        if (c.kind === "brush" && c.brush) brushes.push({ id: c.id, dabs: c.brush.dabs });
      }
    }
    const inputs = [
      this.imageWidth,
      this.imageHeight,
      this.stageTextureBindings,
      ...brushes.flatMap((b) => [b.id, b.dabs]),
      ...keys.map((k) => this.contributedParams[k]),
    ];
    this.maskInputs.bakeIfChanged(inputs, () => {
      const items = [...brushes];
      const painted = coverageItemsFromBag(keys, this.contributedParams);
      items.push(...painted);
      const r = this.updateCoverageTexture(this.maskTexture, items, this.maskSig);
      this.maskSig = r.sig;
      this.maskChannelOf = r.channelOf;
      for (const it of painted) {
        if (it.id in r.channelOf || this.warnedCoverageOverflow.has(it.id)) continue;
        this.warnedCoverageOverflow.add(it.id);
        console.warn(
          `[render] coverage texture '${it.id}' does not fit the ${MAX_BRUSH_MASKS}-channel ` +
            `brush atlas and will read as unpainted.`,
        );
      }
    });
  }

  /** The stages that patch the source (ProcessingStageContribution `patch`):
   *  whether one does this frame, any of its `active` counts above zero, and
   *  a signature of every value they bind, their atlases by their bakes. */
  private patchOf(bag: Record<string, unknown>): { active: boolean; sig: string } {
    const source = this.stageSource();
    let memo = this.patchMemo;
    if (memo?.source !== source) {
      memo = { source, stages: this.currentStages().filter((s) => s.patch && writesRawNames(s)), sigs: new Map() };
      this.patchMemo = memo;
    }
    let active = false;
    const parts: string[] = [];
    for (const s of memo.stages) {
      for (const key of s.patch!.active) {
        const v = bag[`${s.id}.${key}`];
        if (typeof v === "number" && v > 0) active = true;
      }
      // A bag value is replaced, never edited, so the same value is the same text.
      const values = s.uniforms.map((u) => bag[`${s.id}.${u.key}`]);
      const held = memo.sigs.get(s.id);
      if (held && held.values.length === values.length && held.values.every((v, i) => Object.is(v, values[i]))) {
        parts.push(held.sig);
      } else {
        const sig = values.map((v) => JSON.stringify(v ?? null)).join("|");
        memo.sigs.set(s.id, { values, sig });
        parts.push(sig);
      }
      for (const t of s.textures ?? []) {
        if (t.kind === "atlas") parts.push(this.atlas(`${s.id}.${t.key}`, bag[`${s.id}.${t.key}`]).sig);
      }
    }
    return { active, sig: parts.join("|") };
  }

  /** The atlas texture `qk` baked from `value`'s items for this image: the
   *  last bake while neither changed. */
  private atlas(qk: string, value: unknown): { data: StageTextureData; sig: string } {
    let entry = this.atlases.get(qk);
    if (!entry) {
      entry = {
        inputs: new CoverageInputs(),
        data: { data: new Uint8Array(4), width: 1, height: 1, format: "rgba8", version: ++this.atlasVersion },
        sig: "",
      };
      this.atlases.set(qk, entry);
    }
    const held = entry;
    // derive hands over a new list each time; each stroke's dabs are the edit's own.
    const items = atlasItems(value);
    held.inputs.bakeIfChanged([this.imageWidth, this.imageHeight, ...items.flatMap((i) => [i.id, i.dabs])], () => {
      const aspect = this.imageHeight > 0 ? this.imageWidth / this.imageHeight : 1;
      const sig = coverageSignature(items, aspect);
      if (sig === held.sig) return;
      const baked = bakeCoverage(items, aspect);
      held.sig = sig;
      held.data = baked
        ? { data: baked.data, width: baked.size, height: baked.size, format: "rgba8", version: ++this.atlasVersion }
        : { data: new Uint8Array(4), width: 1, height: 1, format: "rgba8", version: ++this.atlasVersion };
    });
    return held;
  }

  private coverageKeys(): string[] {
    return this.stageTextureBindings
      .filter((b) => b.kind === "coverage")
      .map((b) => b.qualifiedKey);
  }

  private setupQuad() {
    const gl = this.gl;
    // pos.xy, uv.xy -- two triangles covering the viewport. Attribute
    // locations are pinned (bindAttribLocation), so this one VAO serves every
    // pipeline program — created once, never rebuilt.
    const data = new Float32Array([
      -1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, -1, 1, 0, 1, 1, -1, 1, 0, 1, 1, 1,
      1,
    ]);
    const vao = gl.createVertexArray();
    this.vao = vao;
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    this.quadBuf = buffer;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(ATTR_POS);
    gl.vertexAttribPointer(ATTR_POS, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(ATTR_UV);
    gl.vertexAttribPointer(ATTR_UV, 2, gl.FLOAT, false, 16, 8);
  }

  /** Largest edge this GL context can hold in a single texture. Callers that
   *  size full-resolution uploads (export at "Original") must stay under it —
   *  an oversized texImage2D fails and the frame renders black. */
  get maxTextureEdge(): number {
    return this.caps.maxTextureSize;
  }

  setImage(
    image:
      | ImageBitmap
      | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean; baselineExposure?: number; baselineShadows?: number }
      | Float16Source,
    maxEdge: number = MAX_EDGE,
    isFallbackPreview = false,
    // Opt-in (thumb renderer only): cap a cached float16 source to maxEdge. It
    // otherwise uploads at its stored size (already bounded by the cache's own
    // edge preference) so the main renderer keeps full-res zoom detail; for
    // thumbnails that wastes GPU memory.
    capFloat16 = false,
  ) {
    const gl = this.gl;
    this.maxEdge = maxEdge;

    // The single imageTexture is reused across opens. The float path writes N
    // RGBA16F mip levels by hand; a later 8-bit load only rewrites level 0,
    // so the leftover higher levels (wrong format/size) make the texture
    // mipmap-incomplete -> generateMipmap throws 0x0502 and the LINEAR_MIPMAP_LINEAR
    // sampler returns black on re-open. Recreate so every load starts level-clean.
    // Only free the previous texture if the renderer owns it. A cache-owned
    // texture (left bound after bindSource) belongs to the cache, which manages
    // its lifetime via eviction; freeing it here would corrupt a cached entry.
    if (this.imageTextureOwned) gl.deleteTexture(this.imageTexture);
    this.imageTexture = createSourceTexture(gl);
    this.imageTextureOwned = true;
    this.sources.unbind();
    this.sourceEpoch++;
    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
    // An error left by earlier work isn't this upload's.
    drainErrors(gl);
    if ("kind" in image) {
      // Linear float (RAW) path — upload as RGBA16F so the develop pipeline keeps
      // ~10-bit precision AND real HDR headroom. The previous code quantized to 8-bit
      // sRGB (mipmaps need a filterable+renderable format), which meant a +5 exposure
      // (×32) stretched ~50 code values across the bright sky into visible bands, and
      // because R/G/B quantize independently their ratios stepped → rainbow posterizing.
      // 16-bit float removes that. WebGL2 can't generateMipmap on RGBA16F without
      // float colour buffers, so the mip chain for the local-contrast taps is built
      // by hand below.
      //
      // A cached develop preview (float16) holds the same scene-linear values as
      // half floats, so it rides this path too and renders like the fresh decode.
      const fromCache = image.kind === "float16";
      const src0 = fromCache ? halfToFloat32(image.data) : image.data;
      // Bound the working texture to the develop cap. The live RAW decode is
      // full sensor resolution; uploading it whole (plus the hand-built mip
      // chain and heal pass) is what exhausted memory on low-RAM machines. The
      // cached preview is already bounded by the cache's edge preference, so
      // only the GL texture limit applies unless capFloat16 asks for maxEdge.
      // Either way the texture limit bounds it: a VM driver's can sit below
      // the develop cap.
      const cap = fromCache && !capFloat16 ? this.maxTextureEdge : Math.min(maxEdge, this.maxTextureEdge);
      const fimg = capFloatToEdge(src0, image.width, image.height, cap);
      this.imageWidth = fimg.width;
      this.imageHeight = fimg.height;
      this.sourceFullWidth = image.kind === "float16" ? image.fullWidth ?? image.width : image.width;
      this.sourceFullHeight = image.kind === "float16" ? image.fullHeight ?? image.height : image.height;
      // Texture now holds true linear scene values, so the shader must NOT sRGB-decode.
      this.linear = true;
      this.isFallbackPreview = fromCache
        ? false
        : (image.isFallbackPreview ?? isFallbackPreview);
      // Real full-res RAW decode (not the pseudo-linear JPEG fallback) renders
      // scene-linear and flat; add the default tone curve to match other views.
      this.applyBaseCurve = !this.isFallbackPreview;
      this.baselineGain = 2 ** (image.baselineExposure ?? 0);
      this.baselineShadows = image.baselineShadows ?? 0;
      // The sample is the sensor's own pixels: cut here from a live decode, or
      // kept in the cache entry beside the preview (3.1.0 and later; an older
      // entry has none). The camera preview is a JPEG and has none either. Only
      // a renderer asked to keep it pays for it.
      this.sourceSample =
        !this.keepSourceSample || this.isFallbackPreview
          ? null
          : image.kind === "float16"
            ? image.sample ?? null
            : this.cutSampleOrSkip(src0, image.width, image.height);
      const f0 = fimg.data;
      uploadFloatMips(gl, f0, fimg.width, fimg.height);
      this.checkSourceUpload();
      // The search image stays 8-bit sRGB (its own pipeline).
      this.keepFill(() => sourcePixelsFromLinear(f0, fimg.width, fimg.height, FILL_EDGE));
    } else {
      // 8-bit sRGB bitmap path. Cap the upload to the develop edge (and never
      // above the GL max texture size) so an oversized bitmap can't fail
      // texImage2D into a black frame — the float path caps the same way.
      const cap = Math.min(maxEdge, this.maxTextureEdge);
      const capped = capDrawableToEdge(image, image.width, image.height, cap);
      this.imageWidth = capped.width;
      this.imageHeight = capped.height;
      this.sourceFullWidth = image.width;
      this.sourceFullHeight = image.height;
      this.sourceSample = null;
      this.linear = false;
      this.isFallbackPreview = isFallbackPreview;
      // Camera-rendered bitmaps already carry a tone curve.
      this.applyBaseCurve = false;
      this.baselineGain = 1;
      this.baselineShadows = 0;
      // Orientation is handled by the vertex shader (V flip). Do NOT use
      // UNPACK_FLIP_Y_WEBGL: it is unreliable for ImageBitmap sources.
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, capped.source,
      );
      this.keepFill(() => downsampleDrawable(image, image.width, image.height));
      // Mip chain for the local-contrast blurs (Texture/Clarity/Dehaze); the
      // float path supplies its own by hand.
      gl.generateMipmap(gl.TEXTURE_2D);
      this.checkSourceUpload();
    }
    this.hasImage = true;
    this.resize();
  }

  // A refused upload (out of memory, say) leaves an incomplete texture that
  // samples black, so it fails the source instead: the texture is let go and
  // nothing is drawn until the next one.
  private checkSourceUpload(): void {
    const gl = this.gl;
    const error = gl.getError();
    if (error === gl.NO_ERROR) return;
    drainErrors(gl);
    gl.deleteTexture(this.imageTexture);
    this.imageTexture = createSourceTexture(gl);
    this.hasImage = false;
    const reason = error === gl.OUT_OF_MEMORY ? "out of GPU memory" : `GL error 0x${error.toString(16)}`;
    throw new Error(`Source upload failed: ${reason}`);
  }

  // ── GPU-resident source cache ──────────────────────────────────────────

  /** Set the LRU byte budget; evicts immediately if already over. */
  setCacheBudget(bytes: number) {
    this.sources.setBudget(bytes);
  }

  /** Is a decoded source for this key already resident? */
  hasSource(key: string): boolean {
    return this.sources.has(key);
  }

  // Decode-and-upload a source under `key`, then bind it as active. Reuses the
  // full setImage upload path, then transfers ownership of the resulting texture
  // (plus its derived render state) into the cache so a later bindSource(key) is
  // a zero-decode swap.
  uploadSource(
    key: string,
    image:
      | ImageBitmap
      | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean; baselineExposure?: number; baselineShadows?: number }
      | Float16Source,
    maxEdge: number = MAX_EDGE,
    isFallbackPreview = false,
    // When false, the source is uploaded into the cache but the previously-active
    // source is re-bound afterwards — used to prefetch neighbours without
    // disturbing the displayed image.
    bind = true,
    // Cap a cached float16 source to maxEdge (thumb renderer only — see setImage).
    capFloat16 = false,
  ) {
    const prevKey = this.sources.bound;
    // Drop any stale entry for this key (e.g. re-decode after an edit changed the
    // pixels) so we don't leak its texture. A bound entry's texture is the active
    // one: adopted, so it's cleaned up normally on the next load.
    if (this.sources.drop(key)) this.imageTextureOwned = true;
    try {
      this.setImage(image, maxEdge, isFallbackPreview, capFloat16);
    } catch (err) {
      // A prefetch that fails must not take the open photo down with it.
      if (!bind && prevKey) this.bindSource(prevKey);
      throw err;
    }
    // setImage built into this.imageTexture and marked it owned; hand it to the cache.
    this.sources.add(key, {
      tex: this.imageTexture,
      width: this.imageWidth,
      height: this.imageHeight,
      linear: this.linear,
      applyBaseCurve: this.applyBaseCurve,
      baselineGain: this.baselineGain,
      baselineShadows: this.baselineShadows,
      isFallbackPreview: this.isFallbackPreview,
      fullWidth: this.sourceFullWidth,
      fullHeight: this.sourceFullHeight,
      sample: this.sourceSample,
      fill: this.fillSrc ? { data: this.fillSrc, w: this.fillW, h: this.fillH } : null,
      maxEdge: this.maxEdge, // setImage just set this from `maxEdge`
    });
    this.imageTextureOwned = false; // the cache owns this texture now
    // Prefetch: restore the source that was active before so the display is
    // unchanged. No render() runs here, so nothing repaints in between.
    if (!bind && prevKey && prevKey !== key && this.sources.has(prevKey)) {
      this.bindSource(prevKey);
    }
    this.sources.evict();
  }

  // Bind a resident source as the active image without re-decoding. Returns false
  // if the key isn't cached (caller should decode + uploadSource). `maxEdge`
  // overrides the output-size cap for this bind (a thumb render caps the output
  // smaller than the source it uploaded); omit it to restore the source's own cap.
  bindSource(key: string, maxEdge?: number): boolean {
    const e = this.sources.bind(key);
    if (!e) return false;
    const gl = this.gl;
    // Release an orphan owned texture (a prior legacy setImage) before pointing
    // at the cached one; never free another cache entry's texture.
    if (this.imageTextureOwned) gl.deleteTexture(this.imageTexture);
    this.imageTexture = e.tex;
    this.imageTextureOwned = false;
    this.sourceEpoch++;
    this.imageWidth = e.width;
    this.imageHeight = e.height;
    this.maxEdge = maxEdge ?? e.maxEdge;
    this.linear = e.linear;
    this.applyBaseCurve = e.applyBaseCurve;
    this.baselineGain = e.baselineGain;
    this.baselineShadows = e.baselineShadows;
    this.isFallbackPreview = e.isFallbackPreview;
    this.sourceFullWidth = e.fullWidth;
    this.sourceFullHeight = e.fullHeight;
    this.sourceSample = e.sample;
    // Restore the search image (the downscaled 8-bit copy) for this image.
    if (e.fill) {
      this.fillSrc = e.fill.data;
      this.fillW = e.fill.w;
      this.fillH = e.fill.h;
    } else {
      this.fillSrc = null;
    }
    this.healSig = "";
    this.hasImage = true;
    this.resize();
    return true;
  }

  /** Hand a resident cached source the decoded size and the centre sample its
   *  completed RAW cache entry now holds (cache-events.ts). True when applied.
   *  Refused, with nothing changed, on a renderer that keeps no samples, for a
   *  key not resident, for a source that already has a sample or is not a
   *  linear decode, for a size that is not positive and finite, and for a size
   *  whose aspect disagrees with the source's: an entry written by an earlier
   *  build under the same key could hold the frame turned the other way. */
  setSourceSample(key: string, fullWidth: number, fullHeight: number, sample: StoredSample): boolean {
    if (!this.keepSourceSample || !this.sources.attachSample(key, fullWidth, fullHeight, sample)) return false;
    if (key === this.sources.bound) {
      this.sourceFullWidth = fullWidth;
      this.sourceFullHeight = fullHeight;
      this.sourceSample = sample;
      // Prepass results are keyed by the epoch, and were drawn with the old uSourceSize.
      this.sourceEpoch++;
    }
    this.sources.evict();
    return true;
  }

  // ── Viewport (zoom ROI) ────────────────────────────────────────────────

  // Render only `roi` (a window into the displayed image, normalized [0,1]) into
  // an output sized to outW×outH. Pass null to return to the whole-frame, crop-
  // capped sizing. Used by a zoomed Develop view to draw the visible region
  // at screen resolution from the resident full-res source.
  setViewport(
    roi: { x: number; y: number; w: number; h: number } | null,
    outW?: number,
    outH?: number,
  ) {
    this.roi = roi;
    this.roiOut = roi && outW && outH ? { w: Math.max(1, Math.round(outW)), h: Math.max(1, Math.round(outH)) } : null;
  }

  /** The window setViewport holds, which each frame is drawn for (null: the whole image). */
  get viewport(): { x: number; y: number; w: number; h: number } | null {
    return this.roi;
  }

  // Size the output canvas to the cropped region (capped at maxEdge). Driven by
  // both setImage and setParams, since the crop lives in the develop params.
  private resize() {
    if (!this.imageWidth || !this.imageHeight) return;
    const crop = this.drawnCrop;
    const cw = this.imageWidth * crop.width;
    const ch = this.imageHeight * crop.height;
    // Zoom ROI: render the window at the requested screen size, but never allocate
    // more output pixels than the source actually provides within the window
    // (beyond that we'd just be upscaling — wasted memory and no extra detail).
    if (this.roi && this.roiOut) {
      const maxW = Math.max(1, Math.round(cw * this.roi.w));
      const maxH = Math.max(1, Math.round(ch * this.roi.h));
      const w = Math.min(this.roiOut.w, maxW);
      const h = Math.min(this.roiOut.h, maxH);
      if (this.canvas.width !== w) this.canvas.width = w;
      if (this.canvas.height !== h) this.canvas.height = h;
      this.gl.viewport(0, 0, w, h);
      return;
    }
    const { width: w, height: h } = this.wholeSize();
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.gl.viewport(0, 0, w, h);
  }

  // The output size of the whole cropped image: the canvas size without a zoom window.
  private wholeSize(): { width: number; height: number } {
    if (!this.imageWidth || !this.imageHeight) return { width: 0, height: 0 };
    return regionOutputSize(this.imageWidth, this.imageHeight, this.drawnCrop, this.maxEdge);
  }

  // Output colour space for subsequent renders. Default sRGB matches the screen;
  // export uses this to convert pixels (and pairs it with an embedded ICC).
  get bufferWidth(): number { return this.canvas.width; }
  get bufferHeight(): number { return this.canvas.height; }
  /** The size the active source is held at, after the upload cap; 0 before any. */
  get sourceWidth(): number { return this.imageWidth; }
  get sourceHeight(): number { return this.imageHeight; }
  /** The decoded source's size before the upload cap (see sourceFullWidth). */
  get sourceFullSize(): { width: number; height: number } {
    return { width: this.sourceFullWidth, height: this.sourceFullHeight };
  }
  /** True while a native-resolution sample is kept for the bound source, on a
   *  renderer asked to keep one (keepSourceSample): a live float decode, or a
   *  cached preview stored with its sample (3.1.0 and later). False for a
   *  bitmap, the camera preview, a cache entry written before, and for any
   *  source on a renderer that keeps none; sourceFullSize is the decoded size
   *  either way. */
  get sourceNative(): boolean {
    return this.sourceSample !== null;
  }
  /** The sample is an optional extra: cutting it allocates about 24 MB beside
   *  the full decode, and failing to must not fail the source it came with. */
  private cutSampleOrSkip(data: Float32Array, width: number, height: number): StoredSample | null {
    try {
      return cutSourceSample(data, width, height);
    } catch (err) {
      console.warn("[renderer] source sample skipped:", err);
      return null;
    }
  }
  /** The native-resolution centre of the bound live decode, or the sample a
   *  cached preview was stored with, as floats, a fresh copy each call, or null
   *  (source-sample.ts). */
  readSourceSample(): SourceSample | null {
    return this.sourceSample ? unpackSourceSample(this.sourceSample) : null;
  }
  /** The size of a frame of the whole image, which a zoom window's frame is a part of. */
  get wholeWidth(): number { return this.wholeSize().width; }
  get wholeHeight(): number { return this.wholeSize().height; }
  /** The bag keys of the geometry stage's region and matrix (geometry.ts). */
  get geometryKeys(): GeometryKeys | null {
    return geometryKeys(this.currentStages());
  }

  /** The geometry stage's region and matrix bindings, when it has them. */
  private geometryBindings(): ContributedBinding[] {
    const keys = geometryKeys(this.currentStages());
    if (!keys) return [];
    return this.contributedBindings.filter((b) => b.qualifiedKey === keys.region || b.qualifiedKey === keys.inverse);
  }

  /** The region of the transformed image a frame is of: the geometry stage's
   *  region (geometry.ts), the whole image without one. */
  get drawnCrop(): CropRect {
    return imageGeometry(this.frameBag(), geometryKeys(this.currentStages()), 1).region;
  }

  setOutputColorSpace(space: ColorSpaceId) {
    this.outSpace = space;
  }

  /** Convert frames into the monitor's profile. Ignored while an export
   *  output space is set, and never applied to the histogram or Upright. */
  setMonitorTransform(transform: MonitorTransform | null) {
    this.monitorTransform = transform;
  }

  /** The space the screen shows, which version 3 frames encode for. An export
   *  output space and a monitor transform both win over it. */
  setDisplaySpace(space: DisplaySpace) {
    this.displaySpace = space;
  }

  /** Soft proof version 3 screen frames in `space`, the export's, or stop
   *  with null. Ignored while an export output space is set. */
  setProofSpace(space: ColorSpaceId | null) {
    this.proofSpace = space;
  }

  // Only frames headed for the screen carry the monitor conversion, the
  // display space or the proof; a measurement binds the plain output. Version
  // 1 and 2 frames stay sRGB on any screen, so an older photo renders as it
  // always has. Returns the tag the drawing buffer needs for this frame. `u`
  // is the develop program's, or sharpening's output pass's.
  private bindOutputSpace(display: boolean, u = this.uniforms): DisplaySpace {
    const gl = this.gl;
    const live = display && this.outSpace === "srgb";
    const t = live ? this.monitorTransform : null;
    const tag: DisplaySpace =
      live && !t && this.variant.signedOutput && this.canTagBuffer ? this.displaySpace : "srgb";
    const space = live ? tag : this.outSpace;
    gl.uniform1i(u.uOutSpace, t ? DISPLAY_CURVE_CODE[t.curve] : OUT_SPACE_CODE[space]);
    const matrix = t ? t.matrix : outMatrixColumnMajor(space);
    gl.uniformMatrix3fv(u.uOutMatrix, false, matrix);
    // Version 1 and 2 programs have none of these, and GL ignores a null location.
    const lms = lmsUniforms(matrix);
    gl.uniformMatrix3fv(u.uOutToLms, false, lms.toLms);
    gl.uniformMatrix3fv(u.uLmsToOut, false, lms.fromLms);
    // Like the display space, the proof reaches only version 3 screen frames,
    // but it is shown in whatever they target, a monitor profile included.
    const proof = live && this.variant.signedOutput ? this.proofSpace : null;
    gl.uniform1i(u.uProof, proof ? 1 : 0);
    if (proof) {
      const proofMatrix = outMatrixColumnMajor(proof);
      const p = proofUniforms(proofMatrix, matrix);
      gl.uniform1i(u.uProofFits, p.fits ? 1 : 0);
      gl.uniformMatrix3fv(u.uProofMatrix, false, proofMatrix);
      gl.uniformMatrix3fv(u.uProofToLms, false, p.toLms);
      gl.uniformMatrix3fv(u.uLmsToProof, false, p.fromLms);
      gl.uniformMatrix3fv(u.uProofToOut, false, p.toOut);
    }
    return tag;
  }

  setAsShotTemperature(kelvin: number) {
    this.asShotTemperature = kelvin >= 2000 && kelvin <= 50000 ? kelvin : 6500;
  }

  setShowClipping(mode: number) {
    this.showClipping = mode & 7;
  }

  // Colour (display-space, 0..1) painted into out-of-image margins, so crop mode
  // frames the photo in the canvas surround instead of a black border.
  setOutsideColor(rgb: [number, number, number]) {
    this.outsideColor = rgb;
  }

  // Drive the coverage overlay. index < 0 disables it; strength animates the fade.
  setMaskViz(index: number, color: [number, number, number], strength: number) {
    this.vizMask = index;
    this.vizColor = color;
    this.vizStrength = strength;
  }

  // Sharpening preview mode: 0 = off, 1 = masking, 2 = detail, 3 = luma.
  setSharpenViz(mode: number) {
    this.sharpenViz = mode;
  }

  /** The photo's params, with what the official and core stages derive from
   *  them (stage-derive.ts). The render worker is handed those from the window,
   *  where the stages' code runs; a renderer in the window derives them from
   *  its own stages, with the derive it was made with. */
  setParams(params: DevelopParams, derived: Record<string, unknown> = this.derivedFor(params)) {
    this.params = params;
    this.derivedValues = derived;
    // Uploaded with the params, as the program's own tables always were, rather
    // than inside the next draw.
    for (const [qk, value] of Object.entries(derived)) {
      const data = photoTextureData(value);
      if (data) this.ensureStageTexture(qk, data, this.uploadedPhotoTex);
    }
    // Atlases bake with the params too, as the masks' does.
    for (const s of this.currentStages()) {
      if (!writesRawNames(s)) continue;
      for (const t of s.textures ?? []) {
        if (t.kind === "atlas") this.atlas(`${s.id}.${t.key}`, derived[`${s.id}.${t.key}`]);
      }
    }
    // The masks' coverage bakes with the next frame instead (render()): params
    // can arrive faster than frames, and each would bake again.
    // NOTE: resize happens in render(), not here. Resizing the canvas clears
    // it, and setParams runs a frame before the coalesced render — doing it
    // here painted a black frame on every crop/straighten/transform change.
  }

  // The 8-bit sRGB downscaled source the window's searches read (Heal's source
  // pick). They run in the window, so the worker forwards this buffer up after
  // every source change; without it a search has no pixels and falls back to a
  // blind offset. Returns a copy so the caller can transfer/clone it.
  sourcePixelsData(): { data: Uint8ClampedArray; w: number; h: number } | null {
    if (!this.fillSrc || this.fillW === 0 || this.fillH === 0) return null;
    return { data: new Uint8ClampedArray(this.fillSrc), w: this.fillW, h: this.fillH };
  }

  private keepFill(downscale: () => { data: Uint8ClampedArray; w: number; h: number }) {
    const ds = this.keepSourcePixels ? downscale() : null;
    this.fillSrc = ds?.data ?? null;
    this.fillW = ds?.w ?? 0;
    this.fillH = ds?.h ?? 0;
    this.healSig = "";
  }

  setStages(stages: ProcessingStageContribution[]) {
    this.stageSource = () => stages;
    this.injectionMemo = null;
    this.patchMemo = null;
    // Copies taken from the set would miss an edit made to this array in place.
    this.copiesMemo = null;
  }

  /** Generic param bag driving extension-contributed stage uniforms, keyed by
   *  qualified key "{stageId}.{key}". Unknown keys are simply never looked up;
   *  a stage uniform with no entry falls back to its declared default. */
  setContributedParams(bag: Record<string, unknown>) {
    this.contributedParams = bag;
  }

  /** Latest pixel data for extension stage textures, keyed by qualified key.
   *  Uploaded lazily at draw time; an unchanged `version` is a no-op. The bag
   *  is whole, so a key it no longer holds was let go of (its extension was
   *  turned off) and its GPU copy is deleted. */
  setStageTextures(bag: Record<string, StageTextureData>) {
    this.stageTextures = bag;
    for (const [qk, uploaded] of this.uploadedStageTex) {
      if (Object.hasOwn(bag, qk)) continue;
      this.gl.deleteTexture(uploaded.tex);
      this.uploadedStageTex.delete(qk);
    }
  }

  /** A 1×1 opaque-black texture bound to any stage sampler that has no data yet,
   *  so the sampler always points at a complete texture. */
  private ensureDummyStageTex(): WebGLTexture {
    const gl = this.gl;
    if (this.dummyStageTex) return this.dummyStageTex;
    const tex = created(gl.createTexture());
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    setSampling(gl, gl.TEXTURE_2D, gl.LINEAR);
    this.dummyStageTex = tex;
    return tex;
  }

  /** Upload (or reuse) the GPU texture for a stage texture by qualified key:
   *  supplied through setStageTextures, or for a photo texture the frame bag's.
   *  Re-uploads only when the supplied `version` changes. */
  private ensureStageTexture(
    qk: string,
    data: StageTextureData | undefined = this.stageTextures[qk],
    uploaded = this.uploadedStageTex,
  ): WebGLTexture {
    const gl = this.gl;
    if (!data) return this.ensureDummyStageTex();
    const cached = uploaded.get(qk);
    if (cached && cached.version === data.version) return cached.tex;
    const max = this.caps.maxTextureSize;
    if (data.width > max || data.height > max) {
      if (this.oversizedStageTex.get(qk) !== data.version) {
        this.oversizedStageTex.set(qk, data.version);
        console.warn(
          `[renderer] stage texture "${qk}" is ${data.width}×${data.height}, past this GPU's ${max} texel limit; the stage draws without it`,
        );
      }
      return this.ensureDummyStageTex();
    }
    const tex = cached?.tex ?? created(gl.createTexture());
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // Format → (internalformat, format, type). Half-float (rgba16f/r16f) is fed
    // from Float32Array with type FLOAT (WebGL2 converts) and is linear-
    // filterable in core WebGL2 — used for LUTs and spectral tables that need
    // interpolation and >8-bit precision.
    let internal: number, fmt: number, type: number, align: number;
    switch (data.format) {
      case "r8":      internal = gl.R8;      fmt = gl.RED;  type = gl.UNSIGNED_BYTE; align = 1; break;
      case "rgba16f": internal = gl.RGBA16F; fmt = gl.RGBA; type = gl.FLOAT;         align = 4; break;
      case "r16f":    internal = gl.R16F;    fmt = gl.RED;  type = gl.FLOAT;         align = 4; break;
      default:        internal = gl.RGBA8;   fmt = gl.RGBA; type = gl.UNSIGNED_BYTE; align = 4; break;
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, align);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, data.width, data.height, 0, fmt, type, data.data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    setSampling(gl, gl.TEXTURE_2D, gl.LINEAR);
    uploaded.set(qk, { tex, version: data.version });
    return tex;
  }

  setActivePipeline(pipeline: ResolvedPipeline) {
    this.pipeline = pipeline;
  }

  /** Build the develop program for a process version under the pipeline and stages
   *  the renderer holds now, so its first frame finds it built. Throws what a frame
   *  would throw for a program that can't be built. It writes only to the renderer's
   *  caches (programs, remembered failures, stage injections, quarantined stages),
   *  never to the stage set, pipeline or bindings it draws with. Whoever creates a
   *  renderer calls this to fail there, ahead of any frame, rather than out of
   *  render(). */
  prepareProgram(processVersion: number): void {
    const variant = shaderVariantFor(processVersion, this.newestVersion);
    this.developEntry(this.pipeline, variant, this.currentStageIds(), undefined);
  }

  /** Build the stock develop program for a process version: the built-in transform
   *  with Safelight's own stages from the stage set the renderer holds (the core
   *  ones and the built-in denoiser) and nothing an extension contributes. It fails
   *  only where this machine can't run Safelight's own shader; stages or a transform
   *  from an extension can fail without it. It writes only to the same caches as
   *  prepareProgram. A caller whose prepareProgram threw uses it to tell the two
   *  cases apart. */
  prepareStockProgram(processVersion: number): void {
    const variant = shaderVariantFor(processVersion, this.newestVersion);
    const builtIn = this.currentStages().filter(isBuiltInStage);
    this.programs.entryFor(
      BUILTIN_RESOLVED,
      buildStageInjection(builtIn, variant, this.samplerBudget),
      variant,
      new Set(builtIn.map((s) => s.id)),
    );
  }

  private derivedFor(params: DevelopParams): Record<string, unknown> {
    if (!this.derive) throw new Error("setParams was handed no derived values, and this renderer has no derive");
    return this.derive(params, this.currentStages());
  }

  private currentStages(): readonly ProcessingStageContribution[] {
    const source = this.stageSource();
    return Array.isArray(source) ? source : Object.values(source);
  }

  private currentStageIds(): ReadonlySet<string> {
    return new Set(this.currentStages().map((s) => s.id));
  }

  /** A set that lost a stage may now fit what the GPU's limits refused, so what
   *  was quarantined from the larger one is tried again: a stage that is broken
   *  alone is only found again. */
  private retryQuarantineIfShrunk(): void {
    if (this.quarantined.size === 0) return;
    const ids = this.currentStageIds();
    if ([...this.quarantinedFrom].every((id) => ids.has(id))) return;
    this.quarantined.clear();
    this.copiesMemo = null;
  }

  /** The stages `variant`'s program is built from: the current ones bar those
   *  quarantined for it. */
  private stagesFor(variant: ShaderVariant): readonly ProcessingStageContribution[] {
    const stages = this.currentStages();
    if (this.quarantined.size === 0) return stages;
    const vk = variantKey(variant);
    return stages.filter((s) => !this.quarantined.get(s.id)?.has(`${stageSignature(s)}|${vk}`));
  }

  /** Quarantine the extension stages `variant`'s program fails to build with,
   *  `failure` being how the whole set failed, and tell the owner of each. They
   *  are found by building it with fewer of them (isolateFailingStages), each
   *  build cached like any other. False when none is to blame: it fails without
   *  any of them, or the context was lost, which fails every build. */
  private quarantineFailing(
    p: ResolvedPipeline,
    variant: ShaderVariant,
    exit: ProgramExit | undefined,
    failure: unknown,
  ): boolean {
    const stages = this.stagesFor(variant);
    const own = stages.filter(isBuiltInStage);
    const contributed = stages.filter((s) => !isBuiltInStage(s));
    const lost = () => this.gl.isContextLost();
    const failing = isolateFailingStages(
      contributed,
      errorText(failure),
      (subset) => {
        const set = [...own, ...subset];
        try {
          const built = buildStageInjection(set, variant, this.samplerBudget);
          this.programs.entryFor(p, built, variant, new Set(set.map((s) => s.id)), exit);
          return null;
        } catch (err) {
          return errorText(err);
        }
      },
      undefined,
      lost,
    );
    if (failing.length === 0 || lost()) return false;
    this.quarantine(failing, variant);
    return true;
  }

  /** Leave `failing` out of `variant`'s programs until each is registered
   *  changed, and tell the owner of each. */
  private quarantine(failing: readonly FailingStage<ProcessingStageContribution>[], variant: ShaderVariant): void {
    this.quarantinedFrom = this.currentStageIds();
    const vk = variantKey(variant);
    for (const { stage, log } of failing) {
      const signature = stageSignature(stage);
      const signed = this.quarantined.get(stage.id) ?? new Set<string>();
      signed.add(`${signature}|${vk}`);
      this.quarantined.set(stage.id, signed);
      console.error(`[renderer] stage "${stage.id}" can't be built; drawing without it until it changes:`, log);
      this.onStageQuarantined?.({ stageId: stage.id, signature, log });
    }
    this.injectionMemo = null;
    this.copiesMemo = null;
  }

  /** An extension stage whose pass failed this frame has no result for its
   *  inline glsl, which would read the raw source in its place (a glow lifting
   *  the whole frame): it is quarantined as a stage whose own glsl doesn't
   *  build is. True when one was, and the frame must be drawn again without it.
   *  A lost context fails every pass, which says nothing of the stage. */
  private quarantineFailedPasses(): boolean {
    const failures = this.prepass.failedPasses;
    if (failures.length === 0 || this.gl.isContextLost()) return false;
    const stages = this.stagesFor(this.variant);
    const failing: FailingStage<ProcessingStageContribution>[] = [];
    for (const { stageId, error } of failures) {
      const stage = stages.find((s) => s.id === stageId);
      if (!stage || isBuiltInStage(stage) || failing.some((f) => f.stage === stage)) continue;
      failing.push({ stage, log: errorText(error) });
    }
    if (failing.length === 0) return false;
    this.quarantine(failing, this.variant);
    return true;
  }

  /** The develop program for `variant` and the injection it was built from. With
   *  more mask copies than this GPU's shader limits hold, it is built without them,
   *  and `dropped` names them. When it can't be built at all, the extension stages
   *  it fails for are quarantined and it is built without them; it throws only when
   *  no stage is to blame. */
  private developEntry(
    p: ResolvedPipeline,
    variant: ShaderVariant,
    stageIds: ReadonlySet<string>,
    exit: ProgramExit | undefined,
  ): { entry: PipelineProgram; built: BuiltStageInjection; dropped: string[] } {
    for (;;) {
      let built = this.stageInjection(variant);
      let failure: unknown;
      try {
        return { entry: this.programs.entryFor(p, built, variant, stageIds, exit), built, dropped: [] };
      } catch (err) {
        failure = err;
      }
      const copies = this.maskCopies(variant);
      if (copies.sig !== "") {
        built = this.stageInjection(variant, false);
        try {
          const entry = this.programs.entryFor(p, built, variant, stageIds, exit);
          return { entry, built, dropped: [...copies.slots.keys()] };
        } catch (err) {
          failure = err;
        }
      }
      // Each pass quarantines at least one more stage, so this ends.
      if (!this.quarantineFailing(p, variant, exit, failure)) throw failure;
    }
  }

  private stageInjection(variant: ShaderVariant, withCopies = true): BuiltStageInjection {
    const source = this.stageSource();
    let memo = this.injectionMemo;
    if (memo?.source !== source) {
      this.retryQuarantineIfShrunk();
      memo = { source, built: new Map() };
      this.injectionMemo = memo;
    }
    const copies = withCopies ? this.maskCopies(variant) : null;
    const key = `${variantKey(variant)}|${copies?.sig ?? ""}`;
    let built = memo.built.get(key);
    if (!built) {
      built = buildStageInjection(copies?.stages ?? this.stagesFor(variant), variant, this.samplerBudget);
      memo.built.set(key, built);
    }
    return built;
  }

  /** The registered stages with the copies the frame's masks call for. The
   *  copies' ids stay out of currentStageIds(): a program is released when a
   *  stage leaves, not when a photo has fewer masks using it. */
  private maskCopies(variant: ShaderVariant = this.variant): MaskInstances {
    const source = this.stageSource();
    const masks = this.params?.masks ?? [];
    const m = this.copiesMemo;
    if (m && m.source === source && m.masks === masks && m.variant === variant) return m.copies;
    const copies = maskInstances(this.stagesFor(variant), masks, variant);
    this.copiesMemo = { source, masks, variant, copies };
    return copies;
  }

  /** The bag the stage uniforms and prepasses read this frame: the photo's,
   *  with the masks' values under their copies' keys. */
  private frameBag(): Record<string, unknown> {
    const copies = this.maskCopies();
    const derived = this.derivedValues;
    if (copies.sig === "" && Object.keys(derived).length === 0) return this.contributedParams;
    const m = this.frameBagMemo;
    if (m && m.params === this.contributedParams && m.derived === derived && m.copies === copies.bag) return m.bag;
    const bag = { ...this.contributedParams, ...derived, ...copies.bag };
    this.frameBagMemo = { params: this.contributedParams, derived, copies: copies.bag, bag };
    return bag;
  }

  private syncPipeline() {
    const p = this.pipeline;
    const variant = this.params
      ? shaderVariantFor(this.params.processVersion, this.newestVersion)
      : this.variant;
    let built = this.stageInjection(variant);
    // A mask probe's frame stops where the mask components read `lin`, a scene
    // measurement where the display transform takes it.
    const exit: ProgramExit | undefined =
      this.redirect?.probe?.point === "mask" ? "mask" : this.redirect?.measure === "scene" ? "scene" : undefined;
    const unchanged =
      p.sig === this.pipelineSig &&
      built.sig === this.stageSig &&
      variant === this.variant &&
      exit === this.programExit;
    // Taken ahead of the early return: a re-registered default changes the
    // bindings and no signature.
    this.transformBindings = p.bindings ?? NO_TRANSFORM_BINDINGS;
    // The stock transform and an empty stage set both sign as "", and the variant
    // starts at version 2, so a fresh renderer can already match its first frame:
    // equal signatures only mean "built" once a program exists.
    if (this.program && unchanged) return;
    // Bar the transform's bindings, which render() binds only where the program
    // it draws with has a location, the renderer changes only once the program is
    // in hand: a build that throws leaves it on the stage set it was drawing with,
    // so switching back to that set finds its own bindings, not the failed set's.
    const stageIds = this.currentStageIds();
    // Dropped mask copies are named by the overflow notice.
    const chosen = this.developEntry(p, variant, stageIds, exit);
    const e = chosen.entry;
    built = chosen.built;
    this.droppedCopies = chosen.dropped;
    this.programs.setCurrent(e);
    // Pass programs are keyed by stageSig; a stage-set change invalidates them
    // and the prepass result cache. No process version changes stageSig, so a
    // photo on the other version keeps both (each kept under its version).
    if (built.sig !== this.stageSig) {
      this.splitTokens.clear();
      // A stage that left the set (its extension was turned off) takes its
      // programs and prepass targets with it.
      this.programs.releaseWithout(stageIds);
      this.prepass.stageSetChanged(built.prepass);
    }
    this.contributedBindings = built.bindings;
    this.maskSlotBindings = built.maskSlots;
    this.stageTextureBindings = built.textureBindings;
    this.prepassStages = built.prepass;
    // The built-in denoiser is in the set only while no extension's noise
    // reduction supersedes it. Where it can't run, the core block, which reads
    // only the source's mips, takes its place.
    const denoiserInSet = built.prepass.some((s) => s.stageId === BUILTIN_DENOISE_ID);
    this.coreNRStandsIn = denoiserInSet && !this.prepass.denoiserRunnable();
    this.skipCoreNR = denoiserInSet ? !this.coreNRStandsIn : built.hasNoiseReduction;
    this.program = e.program;
    this.uniforms = e.uniforms;
    this.pipelineSkipBase = e.skipBase;
    this.pipelineSkipShoulder = e.skipShoulder;
    this.pipelineSig = p.sig;
    this.stageSig = built.sig;
    this.variant = variant;
    this.programExit = exit;
  }

  // The program syncPipeline() last selected. Every draw path syncs first, so a
  // null here is a bug; drawing without a program only raises a GL error and
  // leaves the frame blank, which is why this throws instead.
  private developProgram(): WebGLProgram {
    if (!this.program) throw new Error("WebGLRenderer: drew before syncPipeline() built a program");
    return this.program;
  }

  // `viewOverlays: false` draws without the clipping warning, the mask tint
  // and the sharpening preview, which are for the eye: a frame an extension
  // measures (a gain map, which shadow clipping would paint blue) leaves them
  // out, as computeHistogram does. The view state itself is kept.
  render(options: { viewOverlays?: boolean } = {}): void {
    if (!this.hasImage || !this.params) return;
    const overlays = options.viewOverlays ?? true;
    this.syncPipeline();
    this.resize();
    const gl = this.gl;
    const p = this.params;
    const u = this.uniforms;

    // The mask atlas depends on the source's aspect and the bag (coverage-kind
    // stage textures) as well as the params, and is baked once per frame here
    // however many params came since the last.
    this.updateMaskTexture(p.masks);

    gl.useProgram(this.developProgram());

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
    gl.uniform1i(u.uImage, 0);

    // The tag tells the compositor how to read the canvas. An export frame
    // keeps sRGB whatever it encodes: export reads the canvas back through
    // toBlob and drawImage, which convert out of the tag. Retagging
    // reallocates and clears the buffer, so it happens only on a change, and
    // never for a frame redirected away from the canvas.
    const tag = this.bindOutputSpace(!this.redirect?.measure);
    if (!this.redirect && this.canTagBuffer && gl.drawingBufferColorSpace !== tag) {
      gl.drawingBufferColorSpace = tag;
    }

    gl.uniform1i(u.uLinear, this.linear ? 1 : 0);
    gl.uniform1i(u.uIsFallbackPreview, this.isFallbackPreview ? 1 : 0);
    // A replacement pipeline that brings its own look (AgX, ACES, …) can drop
    // the default RAW base curve and, separately, the core tone shoulder.
    const baseCurve = this.applyBaseCurve && !this.pipelineSkipBase;
    gl.uniform1i(u.uApplyBaseCurve, baseCurve ? 1 : 0);
    gl.uniform1f(u.uBaselineGain, this.baselineGain);
    gl.uniform1f(u.uBaselineShadows, this.baselineShadows / 100);
    gl.uniform1i(u.uApplyToneShoulder, toneShoulderOn(this.variant, this.pipelineSkipShoulder) ? 1 : 0);
    gl.uniform1i(u.uShowClipping, overlays ? this.showClipping & clippingBits(this.variant) : 0);
    gl.uniform3f(u.uOutsideColor, this.outsideColor[0], this.outsideColor[1], this.outsideColor[2]);
    gl.uniform1i(u.uVizMask, overlays ? this.vizMask : -1);
    gl.uniform3f(u.uVizColor, this.vizColor[0], this.vizColor[1], this.vizColor[2]);
    gl.uniform1f(u.uVizStrength, this.vizStrength);
    gl.uniform1i(u.uSharpenViz, overlays ? this.sharpenViz : 0);
    // An output probe and a pre-output measurement (output sharpening, a
    // float capture) read `c` as the output stage receives it, unencoded.
    const raw = this.redirect?.probe?.point === "output" || this.redirect?.measure === "pre-output";
    gl.uniform1i(u.uRawHistogram, raw ? 1 : 0);
    // GLSL zero-initializes uniforms, and 0 is a valid split index: every
    // draw but a split's must run with -1.
    gl.uniform1i(u.uSplitAt, -1);
    // The core block's luminance branch measures detail against the source's
    // mips, which never carry the baseline tone, so behind it the branch shrinks
    // the tone's lift instead of noise and shifts the shadows. Standing in for
    // the denoiser there, the block reduces colour noise only.
    gl.uniform1f(u.uLuminanceNR, this.coreNRStandsIn && baseCurve ? 0 : p.luminanceNR);
    gl.uniform1i(u.uSkipCoreNR, this.skipCoreNR ? 1 : 0);
    gl.uniform1f(u.uLumNRDetail, p.luminanceNRDetail);
    gl.uniform1f(u.uLumNRContrast, p.luminanceNRContrast);
    gl.uniform1f(u.uLumNRShadows, p.luminanceNRShadows);
    gl.uniform1f(u.uLumNRHighlights, p.luminanceNRHighlights);
    gl.uniform1f(u.uColorNR, p.colorNR);
    gl.uniform1f(u.uColorNRDetail, p.colorNRDetail);
    gl.uniform1f(u.uColorNRSmooth, p.colorNRSmoothness);
    gl.uniform1f(u.uAsShotTemperature, this.asShotTemperature);
    gl.uniform1f(u.uClipThreshold, this.linear ? 0.98 : 0.0);

    const vp = this.redirect?.probe?.roi ?? this.roi;
    gl.uniform4f(u.uViewport, vp ? vp.x : 0, vp ? vp.y : 0, vp ? vp.w : 1, vp ? vp.h : 1);


    // Version 2 skips these tools at identity. Version 1 programs have no
    // such uniforms, and GL ignores a null location.


    // Extension-contributed stage uniforms, driven by the generic param bag.
    // Uniforms persist on the program, so binding here once (before the draw
    // passes below) covers both the single-pass and retouch two-pass paths.
    const bag = this.frameBag();
    const aspect = this.imageHeight > 0 ? this.imageWidth / this.imageHeight : 1;
    for (const b of this.contributedBindings) {
      const loc = u[b.qualifiedKey];
      if (loc == null) continue;
      const value = b.space === "image" ? imageSpaceValue(bag, b, aspect) : boundValue(bag, b);
      bindUniformByType(gl, loc, b.glslType, value, b.length);
    }
    for (const b of this.transformBindings) {
      const loc = u[b.qualifiedKey];
      if (loc == null) continue;
      const held = bag[b.qualifiedKey];
      const value = isUniformValue(held, b.glslType) ? held : b.default;
      // Nine numbers either way: isUniformValue took the value for mat3, and
      // registration refuses a mat3 default it wouldn't take.
      if (b.glslType === "mat3") gl.uniformMatrix3fv(loc, false, value as number[]);
      else bindUniformByType(gl, loc, b.glslType, value);
    }

    // Extension stage textures (baked LUT atlases). Bound to units 12.. (above
    // the fixed 0-7 and prepass 8-11 ranges; prepass results only take the ones
    // left over), so they stay resident through the mask/retouch binds below and
    // the draw passes. Like the scalar uniforms, the sampler binding persists on
    // the program across both draw paths.
    // Official stages' per-photo tables take the units the program bound them
    // at itself (PHOTO_TEX_UNITS), then the units after the stage textures.
    {
      const units = stageTextureUnits(this.stageTextureBindings);
      for (const tb of this.stageTextureBindings) {
        const unit = units.get(tb.qualifiedKey);
        const loc = u[tb.qualifiedKey];
        if (unit === undefined || loc == null) continue;
        gl.activeTexture(gl.TEXTURE0 + unit);
        const tex =
          tb.kind === "photo"
            ? this.ensureStageTexture(tb.qualifiedKey, photoTextureData(bag[tb.qualifiedKey]), this.uploadedPhotoTex)
            : tb.kind === "atlas"
              ? this.ensureStageTexture(tb.qualifiedKey, this.atlas(tb.qualifiedKey, bag[tb.qualifiedKey]).data, this.uploadedPhotoTex)
              : this.ensureStageTexture(tb.qualifiedKey);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(loc, unit);
      }
    }

    // Masks + retouch
    gl.uniform1f(u.uImageAspect, aspect);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    gl.uniform1i(u.uMaskTex, 2);
    for (const tb of this.stageTextureBindings) {
      if (tb.kind !== "coverage") continue;
      const loc = u[tb.qualifiedKey];
      if (loc != null) gl.uniform1i(loc, this.maskChannelOf[tb.qualifiedKey] ?? -1);
    }

    gl.uniform1i(u.uHaveDeveloped, 0);

    // Keep unit 4 (uDevelopedSrc) pointed at a valid texture.
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
    gl.uniform1i(u.uDevelopedSrc, 4);

    // The stages that patch the source (Heal's): whether any patches this frame,
    // and what the patched copy depends on, which keys the prepass cache (e.g.
    // denoise, which the default Colour NR keeps on): without it the patched
    // result stays stale until an app restart clears the prepass result targets.
    const patch = this.patchOf(bag);
    const hasRetouch = patch.active;
    const { w: devW, h: devH } = this.prepassDims();
    const patched =
      hasRetouch &&
      this.imageWidth > 0 &&
      this.imageHeight > 0 &&
      this.patchedSource.bake(devW, devH, this.variant, () => this.drawPatchPass());
    const developed = this.patchedSource.texture;
    if (patched && developed) {
      // Prepasses (e.g. denoise) read the PATCHED source so heal happens before
      // detail; results are bound onto the main program for pass 2. The patched
      // source varies with retouch/heal geometry, so fold those into the cache key,
      // and with the process version and the copy's format, which decide what it
      // clips: a photo on the other version must not reuse this one's result.
      this.prepass.run(
        this.prepassFrame(
          developed,
          `e${this.sourceEpoch}|p${patch.sig}|h${this.healSig}` +
            `|${variantKey(this.variant)}:${this.patchedSource.format}`,
          false,
          p,
        ),
      );
      if (this.quarantineFailedPasses()) return this.render(options);
      // Pass 2 -> develop from the patched copy (now the spot is already gone,
      // so texture/clarity/sharpening can't invert it). Retouch off this pass.
      this.drawDevelop(developed, false, this.outputTarget());
    } else {
      // No retouch (or no offscreen target): single pass. The in-shader retouch
      // is the fallback when the framebuffer can't be created.
      this.prepass.run(this.prepassFrame(this.imageTexture, `e${this.sourceEpoch}`, hasRetouch, p));
      if (this.quarantineFailedPasses()) return this.render(options);
      this.drawDevelop(this.imageTexture, hasRetouch, this.outputTarget());
    }
  }

  private outputTarget(): DrawTarget {
    return this.redirect ?? { fbo: null, w: this.canvas.width, h: this.canvas.height };
  }

  // One develop draw of the main program over `srcTex` into `target`, with
  // the prepass results produced so far this frame. The main draws and the
  // split draws all go through here, so a per-draw uniform added later can't
  // reach one and miss another.
  private drawDevelop(srcTex: WebGLTexture, applyRetouch: boolean, target: DrawTarget): void {
    const gl = this.gl;
    const u = this.uniforms;
    gl.useProgram(this.developProgram());
    this.bindPrepassResults();
    this.bindMaskSlots();
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(u.uImage, 0);
    gl.uniform1i(u.uPatchPass, 0);
    gl.uniform1i(u.uApplyRetouch, applyRetouch ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // Render the current frame into an RGBA16F framebuffer and read back the
  // float pixels — top-down, RGBA, display-encoded in [0,1]: the output encode
  // clamps, so no value exceeds 1 or falls below 0, however much headroom the
  // frame had. Drives the same render() path as the canvas, so all
  // develop/extension stages are baked in. Returns null when float render
  // targets aren't available, so the caller falls back to the 8-bit path.
  captureFloatFrame(): { data: Float32Array; width: number; height: number } | null {
    if (!this.hasImage || !this.params || !this.caps.colorBufferFloat) return null;
    // Size the canvas/viewport exactly as a normal render would (crop-capped).
    this.syncPipeline();
    this.resize();
    const w = this.canvas.width;
    const h = this.canvas.height;
    const raw = this.drawFloat(w, h);
    if (!raw) return null;
    return { data: topDown(raw, w, h), width: w, height: h };
  }

  /** The current frame as floats at the canvas's size, RGBA, top-down, in
   *  `space`: converted from perceptual Rec.709 texel by texel, then averaged
   *  down where `captureEdge` (measureSize) caps its long edge. At
   *  "pre-output" it is the signed `c` the output stage receives, at "output"
   *  what the output stage makes of it: sRGB as long as no export output space
   *  is set, which holds for the worker's live and thumb renderers. At "scene"
   *  it is the scene-linear `lin` the display transform receives. A
   *  measurement, like an export frame: without the view's overlays, the
   *  screen's space, the monitor profile or the proof. Null with no source,
   *  without float render targets, or when a target can't be allocated or
   *  completed. */
  readFloatFrame(
    point: CapturePoint,
    captureEdge = Infinity,
    space: StageSpace = DEFAULT_CAPTURE_SPACE,
  ): { data: Float32Array; width: number; height: number } | null {
    if (!this.hasImage || !this.params || !this.caps.colorBufferFloat) return null;
    this.syncPipeline();
    this.resize();
    const gl = this.gl;
    const full = { w: this.canvas.width, h: this.canvas.height };
    const { width: w, height: h } = measureSize(full.w, full.h, captureEdge);
    let raw: Float32Array | null;
    try {
      // As for an export: a driver may refuse a target, or report the memory
      // only at the first draw into it, leaving that draw undefined. The queue
      // is emptied first, so only this frame's errors are read, and none is
      // left for the next reader.
      ranOutOfMemory(gl);
      if (w === full.w && h === full.h && isIdentitySpace(space, "display")) {
        raw = this.drawFloat(w, h, { measure: point }, gl.RGBA32F);
        if (ranOutOfMemory(gl)) raw = null;
      } else {
        // Converted and averaged down on the GPU from the full view's frame:
        // the worker does no work per pixel, the read-back shrinks with the
        // frame, and the detail tools still act at the view's scale, as a
        // smaller view of it shows them.
        raw = this.readback.downsampled(full, { w, h }, space, (fbo) =>
          this.drawRedirected({ fbo, ...full, measure: point }),
        );
      }
    } finally {
      // A scene capture's program isn't the frame's.
      this.syncPipeline();
      this.bindFrameState();
    }
    return raw && { data: topDown(raw, w, h), width: w, height: h };
  }

  /** Whether a photo with `params` renders through version 3's signed output
   *  stage here: the renderer's cap can hold it to an older version. */
  signedOutputFor(params: DevelopParams): boolean {
    return shaderVariantFor(params.processVersion, this.newestVersion).signedOutput;
  }

  /** The current frame as a version 3 16-bit export: drawn at captureFloatFrame's
   *  size into the first of `targets` this context can render, sharpened when
   *  asked, and read back as codes, RGBA, top-down. Null for a photo without
   *  the signed output stage, which exports through captureFloatFrame as it
   *  always has, with no source, when no target can be allocated, or when the
   *  frame is too large to read back. */
  exportPixels(opts: ExportPixelsOptions = {}): ExportPixels | null {
    if (!this.hasImage || !this.params || !this.signedOutputFor(this.params)) return null;
    this.syncPipeline();
    this.resize();
    const w = this.canvas.width;
    const h = this.canvas.height;
    const { sharpen } = opts;
    return drawExport(this.gl, w, h, opts.targets ?? EXPORT_TARGETS, (fbo, kind) => {
      if (sharpen) return this.sharpenInto(sharpen, { fbo, kind });
      this.drawRedirected({ fbo, w, h, measure: "output" });
      return true;
    });
  }

  /** The current frame for an 8-bit export, sharpened on the signed colour and
   *  then mapped by the output stage, drawn into the canvas. False, with no
   *  frame drawn, for a photo without the signed output stage, with no source,
   *  or when no float texture can hold the frame: the caller then sharpens on
   *  the CPU, as for older photos. By that last refusal the canvas has been
   *  sized for the frame, which clears it if its size changed. */
  renderSharpened(sharpen: Sharpen): boolean {
    if (!this.hasImage || !this.params || !this.signedOutputFor(this.params) || !this.caps.colorBufferFloat) {
      return false;
    }
    this.syncPipeline();
    this.resize();
    return this.sharpenInto(sharpen, null);
  }

  // The frame at the canvas's size, sharpened into an export target, or into
  // the canvas for null. False when there's no float texture for `c`.
  private sharpenInto(sharpen: Sharpen, target: ExportFramebuffer | null): boolean {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    try {
      return this.readback.sharpened(
        { w, h, sharpen, target },
        (fbo) => this.drawRedirected({ fbo, w, h, measure: "pre-output" }),
        (uniforms) => {
          // An export reads the canvas back through toBlob and drawImage, which
          // convert out of its tag, so a frame encoded for sRGB must say so.
          // A live view's next frame tags it for the screen again.
          if (!target && this.canTagBuffer && gl.drawingBufferColorSpace !== "srgb") {
            gl.drawingBufferColorSpace = "srgb";
          }
          this.bindOutputSpace(false, uniforms);
        },
      );
    } finally {
      this.bindFrameState();
    }
  }

  /** The linear colour around (u, v) of the live frame, x right and y down in
   *  [0, 1] across its buffer, averaged over 5×5 of its pixels, moved inside
   *  the image at its edge. It is drawn
   *  from the params, bag and pipeline held now, without the view's overlays.
   *  "output" is the colour the output stage receives; "mask" the scene-linear
   *  colour the mask components compare. Null with no source or no float
   *  render targets. */
  probe(u: number, v: number, point: ProbePoint): [number, number, number] | null {
    if (!this.hasImage || !this.params || !this.caps.colorBufferFloat) return null;
    const live = this.roi ?? { x: 0, y: 0, w: 1, h: 1 };
    const roi = probePatch(live, u, v, this.canvas.width, this.canvas.height);
    try {
      const raw = this.drawFloat(PROBE_PX, PROBE_PX, { probe: { roi, point } });
      if (!raw) return null;
      // The mask point is linear already. Version 3 hands its output stage
      // signed perceptual values; versions 1 and 2 encode `c` clipped to
      // [0, 1], with the sRGB curve over that range.
      return probeMean(raw, (c) =>
        point === "mask"
          ? c
          : decodePerceptual(this.variant.signedOutput ? c : Math.min(Math.max(c, 0), 1)),
      );
    } finally {
      // A mask probe's program isn't the frame's.
      this.syncPipeline();
      this.bindFrameState();
    }
  }

  // computeHistogram and Upright redraw with what is bound, so every draw away
  // from the live frame puts back what it left: the frame's program, encoding
  // its output over the live window, at the canvas's size.
  private bindFrameState(): void {
    const gl = this.gl;
    const vp = this.roi;
    gl.useProgram(this.developProgram());
    gl.uniform1i(this.uniforms.uRawHistogram, 0);
    gl.uniform4f(this.uniforms.uViewport, vp ? vp.x : 0, vp ? vp.y : 0, vp ? vp.w : 1, vp ? vp.h : 1);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  // Draws a frame through render() into a w×h float target, RGBA16F unless
  // `format` is RGBA32F, and reads it back, bottom-up: the whole frame, a
  // probe's patch or a measurement, each as Redirect describes it. Null when
  // the target can't be completed.
  private drawFloat(
    w: number,
    h: number,
    draw: Pick<Redirect, "probe" | "measure"> = {},
    format: number = this.gl.RGBA16F,
  ): Float32Array | null {
    return this.readback.floatPixels(w, h, format, (fbo) => this.drawRedirected({ ...draw, fbo, w, h }));
  }

  // Draws a frame through render() into the redirect's target instead of the
  // canvas. A probe's patch and a measurement leave out the view's overlays.
  private drawRedirected(redirect: Redirect): void {
    try {
      this.redirect = redirect;
      this.render({ viewOverlays: !redirect.probe && !redirect.measure });
    } finally {
      this.redirect = null;
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  computeHistogram(extended = false): HistogramData {
    const gl = this.gl;
    // It redraws what the last render() left bound, so before one there is no
    // frame to measure: the draw would raise a GL error and read back black.
    if (!this.program) return emptyHistogram();

    // Re-render the display output at a small size and read it back. We share
    // GL state with the clipping/viz uniforms reset to off so the sampled frame
    // is the plain developed image, in sRGB: Auto Tone and Auto WB read it, so
    // a display profile must not reach it.
    gl.uniform1i(this.uniforms.uShowClipping, 0);
    gl.uniform1i(this.uniforms.uVizMask, -1);
    gl.uniform1i(this.uniforms.uSharpenViz, 0);
    this.bindOutputSpace(false);
    // A zoomed render leaves only the visible window bound; Auto Tone and Auto
    // WB read this histogram, so it measures the whole picture.
    gl.uniform4f(this.uniforms.uViewport, 0, 0, 1, 1);

    const result = this.readback.histogram(extended, this.uniforms.uRawHistogram);

    this.bindFrameState();
    return result;
  }

  readDownscaledPixels(size: number): { data: Uint8Array; w: number; h: number } | null {
    // Like computeHistogram, it draws with what the last render() left bound.
    if (!this.program || !this.imageWidth || !this.imageHeight) return null;
    const gl = this.gl;
    const { w, h } = downscaledSize(this.imageWidth / this.imageHeight, size);

    // Temporarily override the geometry and viewport to the whole image,
    // unchanged, so we detect lines across the whole raw frame, not a corrected
    // or zoom-windowed view.
    const u = this.uniforms;
    const geometry = this.geometryBindings();
    for (const b of geometry) {
      const loc = u[b.qualifiedKey];
      if (loc == null) continue;
      if (b.glslType === "mat3") gl.uniformMatrix3fv(loc, false, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
      else gl.uniform4f(loc, 0, 0, 1, 1);
    }
    gl.uniform4f(u.uViewport, 0, 0, 1, 1);

    // Re-bind the source image on unit 0 so the shader samples it correctly
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
    gl.uniform1i(u.uShowClipping, 0);
    gl.uniform1i(u.uVizMask, -1);
    gl.uniform1i(u.uSharpenViz, 0);
    this.bindOutputSpace(false);
    // Top-down, as the Hough line detector expects.
    const data = this.readback.downscaled(w, h);

    // Restore the real transform and crop, then the rest of the frame's state.
    const bag = this.frameBag();
    const imgAspect = this.imageHeight > 0 ? this.imageWidth / this.imageHeight : 1;
    for (const b of geometry) {
      const loc = u[b.qualifiedKey];
      if (loc == null) continue;
      const value = b.space === "image" ? imageSpaceValue(bag, b, imgAspect) : boundValue(bag, b);
      bindUniformByType(gl, loc, b.glslType, value, b.length);
    }
    this.bindFrameState();
    return { data, w, h };
  }

  // ── Multi-pass prepass framework ────────────────────────────────────────

  // What this frame's prepasses are drawn from and at. A redirected frame (a
  // capture or a probe) is never limited in the mask copies it runs.
  private prepassFrame(
    srcTex: WebGLTexture,
    srcSig: string,
    applyRetouch: boolean,
    params: DevelopParams,
  ): PrepassFrame {
    const { w, h } = this.prepassDims();
    const bag = this.frameBag();
    // Texture versions are read every frame, on the first split: the export
    // renderer shares the main thread's stage-texture record, which is updated in place.
    let textureVersions: Record<string, number> | null = null;
    const splitToken = (stageId: string, split: StageSplit): number => {
      if (!textureVersions) {
        textureVersions = {};
        for (const [qk, data] of Object.entries(this.stageTextures)) textureVersions[qk] = data.version;
      }
      return this.splitTokens.token(stageId, split, {
        params,
        bag,
        textureVersions,
        transformBindings: this.transformBindings,
        context: [this.pipelineSig, variantKey(this.variant), this.asShotTemperature, this.skipCoreNR].join("|"),
      });
    };
    return {
      stages: this.prepassStages,
      srcTex,
      srcSig,
      applyRetouch,
      splitToken,
      w,
      h,
      baseCurve: this.applyBaseCurve && !this.pipelineSkipBase ? 1 : 0,
      bag,
      copySlots: this.maskCopies().slots,
      units: this.prepassUnitPool(),
      copyBudget: this.redirect ? Infinity : this.maskCopyPrepassesPerFrame,
      epoch: this.sourceEpoch,
      stageSig: this.stageSig,
      processVersion: this.variant.version,
      linear: this.linear,
      isFallbackPreview: this.isFallbackPreview,
      sourceWidth: this.sourceFullWidth,
      sourceHeight: this.sourceFullHeight,
    };
  }

  // Source-capped dimensions the prepasses render at (matches the develop target
  // sizing, so a prepass result sampled at srcUv aligns 1:1 with uImage[srcUv]).
  private prepassDims(): { w: number; h: number } {
    const longEdge = Math.max(this.imageWidth, this.imageHeight);
    const scale = longEdge > 0 ? Math.min(1, this.maxEdge / longEdge) : 1;
    return {
      w: Math.max(1, Math.round(this.imageWidth * scale)),
      h: Math.max(1, Math.round(this.imageHeight * scale)),
    };
  }

  // The units prepass results may take under the current stage set: every unit
  // the develop program and its stage textures leave free.
  private prepassUnitPool(): number[] {
    const units = [...stageTextureUnits(this.stageTextureBindings).values()];
    return prepassUnits(this.caps.combinedTextureUnits, units.filter((u) => u >= STAGE_TEX_UNIT_BASE).length);
  }

  // Bind each prepass result onto the (already active) main program.
  private bindPrepassResults() {
    const gl = this.gl;
    this.bindResultArray();
    for (const r of this.prepass.frameResults) {
      if (r.kind === "layer") {
        const loc = this.uniforms[r.layerUniform];
        if (loc != null) gl.uniform1i(loc, r.layer);
        continue;
      }
      const loc = this.uniforms[r.resultUniform];
      if (loc == null) continue;
      gl.activeTexture(gl.TEXTURE0 + r.unit);
      gl.bindTexture(gl.TEXTURE_2D, r.tex);
      gl.uniform1i(loc, r.unit);
    }
    // Tell the main shader whether the built-in denoise result is real this frame
    // (set during the prepass run) so its inline only swaps `lin` when it's valid.
    const okLoc = this.uniforms.uDenoiseReady;
    if (okLoc != null) gl.uniform1i(okLoc, this.prepass.denoised ? 1 : 0);
  }

  // Each mask copy's coverage slot: its mask's index, or -1 while the mask
  // applies nothing or the copy's prepass hasn't run yet. A copy the program
  // has but the frame's masks don't call for (a program kept from another
  // photo after a failed build) gets -1 too.
  private bindMaskSlots(): void {
    const slots = this.maskCopies().slots;
    for (const ms of this.maskSlotBindings) {
      const loc = this.uniforms[ms.glslName];
      if (loc == null) continue;
      const slot = this.prepass.unshownCopy(ms.stageId) ? -1 : (slots.get(ms.stageId) ?? -1);
      this.gl.uniform1i(loc, slot);
    }
  }

  // Points a layered program's result array at the first prepass unit.
  private bindResultArray(): void {
    const gl = this.gl;
    const arrayLoc = this.uniforms[RESULT_ARRAY_UNIFORM];
    if (arrayLoc == null) return;
    const unit = this.prepassUnitPool()[0];
    // Fetched first: making the stand-in moves the active unit.
    const tex = this.prepass.layersTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.uniform1i(arrayLoc, unit);
  }

  // Draw the develop program up to one stage's input into the runner's first
  // ping-pong target, in source texels at prepass size, for that stage's first
  // pass to read. Only results already produced this frame are bound, and the
  // target is never bound as a sampler: unit 0 holds the source when the draw
  // runs. uSplitAt is set on the main program around this one draw, so no
  // other draw sees it.
  private drawSplit(index: number, srcTex: WebGLTexture, applyRetouch: boolean, target: DrawTarget): void {
    const gl = this.gl;
    gl.useProgram(this.developProgram());
    gl.uniform1i(this.uniforms.uSplitAt, index);
    this.drawDevelop(srcTex, applyRetouch, target);
    gl.uniform1i(this.uniforms.uSplitAt, -1);
  }

  // The patch pass of a retouched frame, into the framebuffer PatchedSource binds.
  private drawPatchPass(): void {
    const gl = this.gl;
    const u = this.uniforms;
    // Break a feedback loop: bindPrepassResults (end of the previous frame) may
    // leave the patched copy bound to a prepass-result sampler unit. Rendering INTO
    // the copy here while it's still bound as a sampler input on the active
    // program is a GL feedback loop (undefined — drivers can drop the write,
    // leaving the patched source stale, so heal edits never appear when a stage
    // with an active prepass result is registered). Detach those units first.
    for (const pu of this.prepassUnitPool()) {
      gl.activeTexture(gl.TEXTURE0 + pu);
      gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
    }
    // This draw comes before the frame's bindPrepassResults, and a freshly linked
    // program has every sampler on unit 0: the result array left there beside
    // uImage is two sampler types on one unit, which fails the draw.
    this.bindResultArray();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture); // read the original source
    gl.uniform1i(u.uImage, 0);
    gl.uniform1i(u.uPatchPass, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  dispose() {
    const gl = this.gl;
    // Free every resident source, plus the active image texture if the renderer
    // still owns it (a cache-owned active texture is freed with the cache).
    this.sources.dispose();
    if (this.imageTextureOwned) gl.deleteTexture(this.imageTexture);
    this.patchedSource.dispose();
    gl.deleteTexture(this.maskTexture);
    // Histogram targets and the sharpening and box-filter programs.
    this.readback.dispose();
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.quadBuf) gl.deleteBuffer(this.quadBuf);
    // Prepass framework: ping-pong targets, per-stage results, pass programs.
    this.prepass.dispose();
    // Extension stage textures (LUT atlases) + the shared dummy.
    for (const e of this.uploadedStageTex.values()) gl.deleteTexture(e.tex);
    this.uploadedStageTex.clear();
    for (const e of this.uploadedPhotoTex.values()) gl.deleteTexture(e.tex);
    this.uploadedPhotoTex.clear();
    if (this.dummyStageTex) gl.deleteTexture(this.dummyStageTex);
    // The active program is always one of the cache's entries, so the cache covers it.
    this.programs.dispose();
  }
}
