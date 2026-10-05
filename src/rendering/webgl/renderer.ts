// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { DevelopParams, Mask, MaskAdjustments, RetouchSpot } from "@/catalog/types";
import {
  DEFAULT_CROP,
  HSL_CHANNELS,
  MAX_BRUSH_MASKS,
  MAX_MASKS,
  MAX_MASK_COMPONENTS,
  MAX_RETOUCH,
  MAX_RETOUCH_BRUSH,
  isDefaultHSL,
  isDefaultToneCurves,
  isNeutralColorGrading,
  maskHasDisplayAdjustments,
} from "@/catalog/types";
import type { HistogramData } from "../histogram";
import { buildMaskCurveLUT, buildRGBCurveLUT } from "../curve";
import { buildInverseTransform, mat3ColumnMajor } from "../transform";
import {
  buildFragmentShader,
  shaderVariantFor,
  variantKey,
  V2_VARIANT,
  VERTEX_SHADER,
  type ShaderVariant,
} from "./shaders";
import { BUILTIN_DENOISE_ID } from "./builtin-denoise";
import { isBuiltInStage } from "./builtin-stage";
import { simpleHash } from "./shader-compiler";
import {
  PASS_VERTEX_SHADER,
  buildStageInjection,
  type BuiltStageInjection,
  type ContributedBinding,
  type PrepassStage,
  type StageSplit,
  type StageTextureBinding,
} from "./stage-injection";
import { SplitTokens } from "./split-signature";
import { useRegistry } from "@/extensions/registry";
import {
  type GlslType,
  type ProcessingStageContribution,
  type StageTextureData,
} from "@/extensions/types";
import { coverageItemsFromBag, paramIsActive } from "./stage-coverage";
import {
  OUT_SPACE_CODE,
  outMatrixColumnMajor,
  type ColorSpaceId,
} from "../color-space";
import {
  BUILTIN_RESOLVED,
  resolveDefaultPipeline,
  type ResolvedPipeline,
} from "@/extensions/pipelines";
import {
  CoverageInputs,
  bakeCoverage,
  coverageSignature,
  type CoverageItem,
} from "./mask-coverage";
import { healImageFromLinear, setHealSourceImage } from "../heal-source";
import { getSettings } from "@/state/settings-store";
import { halfToFloat32 } from "@/raw/half-float";

// Fixed attribute locations (bound before link), so every pipeline variant of
// the program shares the one VAO — swapping pipelines never rebuilds geometry.
const ATTR_POS = 0;
const ATTR_UV = 1;

// Texture units for prepass result samplers. The develop shader owns 0 (image),
// 1 (curve), 2 (mask), 3 (retouch), 4 (developed), 6 (mask curves) and uses 7 as
// transient scratch; unit 5 is the one free slot below the prepass range, listed
// last so the four long-standing prepass units keep their numbers. Five slots let
// the builtin denoise and a four-stage extension (e.g. the Contrast Equalizer's
// wavelet octaves) hold results at once within the 16 fragment units WebGL2
// guarantees (ANGLE reports exactly 16).
const PREPASS_UNITS: readonly number[] = [8, 9, 10, 11, 5];
const MAX_PREPASS_STAGES = PREPASS_UNITS.length;

// Extension stage textures (baked LUT atlases, etc.) bind above the classic
// prepass range; 12-15 stay inside the 16-unit guarantee.
const STAGE_TEX_UNIT_BASE = 12;
const MAX_STAGE_TEXTURES = 4;

// One compiled develop program per pipeline, stage set and process version:
// switching transforms or photos (or back) is an O(1) swap with no shader
// recompile or uniform re-query.
interface PipelineProgram {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
  skipBase: boolean;
  skipShoulder: boolean;
}

// Where a develop draw lands: a framebuffer (null for the canvas) and its size.
interface DrawTarget {
  fbo: WebGLFramebuffer | null;
  w: number;
  h: number;
}

// Storage of the retouched frame's patched copy of the source. Only "float16"
// keeps values outside [0, 1]; "norm16" (EXT_texture_norm16) and "rgba8" clip.
type DevelopedFormat = "rgba8" | "norm16" | "float16";

// Default cap on render resolution for interactive performance. Export passes
// a larger value (or the image's own long edge) to render at full size.
const MAX_EDGE = 2560;

// Default GPU source-cache budget (bytes) before LRU eviction kicks in. Overridable
// per renderer via setCacheBudget (driven by the gpuSourceCacheBytes preference).
const DEFAULT_SOURCE_CACHE_BYTES = 512 * 1024 * 1024;

// A decoded source kept resident on the GPU. `tex` is owned by the cache; its
// derived render state is restored verbatim on bind so a re-open matches the
// original decode exactly.
interface SourceEntry {
  tex: WebGLTexture;
  width: number;
  height: number;
  linear: boolean;
  applyBaseCurve: boolean;
  isFallbackPreview: boolean;
  fill: { data: Uint8ClampedArray; w: number; h: number } | null;
  // The output-size cap this source was uploaded with. Restored on bind so a
  // cache-hit render doesn't inherit a stale cap from the previously-active
  // source (which sized the output wrong — the export-bug class).
  maxEdge: number;
  bytes: number;
  lastUsed: number;
}

// Working resolution for the CPU heal-source search (and the disabled
// content-aware fill). Big enough that thin structures (edges, lines) survive
// the downscale so the source picker can match and continue them; the search
// cost is independent of this, only the sampling fidelity changes.
const FILL_EDGE = 384;

// Gradient-domain (membrane) heal: heal spots blend their copied texture into the
// surroundings with a per-pixel low-frequency correction instead of one flat mean
// offset, so the seam vanishes across tone gradients. Flip to false to A/B against
// the old flat-tint path (clone is unaffected either way).
const MEMBRANE_HEAL = true;

// Box-halve an RGBA Float32 image (linear space). Used to build a float mip chain
// by hand: WebGL2 cannot generateMipmap on RGBA16F without float colour buffers,
// but it can sample manually supplied float mip levels with trilinear filtering,
// which the local-contrast taps (Texture/Clarity/Dehaze/Sharpen) need. Working in
// 16-bit float keeps real precision and HDR headroom so a big exposure push
// doesn't posterise into bands.
function halveRGBAF(src: Float32Array, w: number, h: number) {
  const nw = Math.max(1, w >> 1);
  const nh = Math.max(1, h >> 1);
  const out = new Float32Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const y0 = Math.min(h - 1, y * 2), y1 = Math.min(h - 1, y * 2 + 1);
    for (let x = 0; x < nw; x++) {
      const x0 = Math.min(w - 1, x * 2), x1 = Math.min(w - 1, x * 2 + 1);
      const i00 = (y0 * w + x0) * 4, i01 = (y0 * w + x1) * 4;
      const i10 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
      const o = (y * nw + x) * 4;
      for (let k = 0; k < 4; k++) {
        out[o + k] = (src[i00 + k] + src[i01 + k] + src[i10 + k] + src[i11 + k]) * 0.25;
      }
    }
  }
  return { data: out, w: nw, h: nh };
}

// Box-average a linear Float32 RGBA image down so its long edge ≤ maxEdge.
// Returns the input unchanged when it already fits. Bounds the GPU texture,
// the hand-built float mip chain, AND the heal-source pass to the develop cap —
// without this a full-res sensor decode (e.g. 24MP NEF → 384 MB Float32) was
// uploaded whole, OOMing low-RAM machines even though the canvas was capped.
function capFloatToEdge(
  data: Float32Array,
  W: number,
  H: number,
  maxEdge: number,
): { data: Float32Array; width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(W, H));
  if (scale >= 1) return { data, width: W, height: H };
  const w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));
  const out = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor((y * H) / h);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * H) / h));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x * W) / w);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * W) / w));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const si = (sy * W + sx) * 4;
          r += data[si]; g += data[si + 1]; b += data[si + 2]; a += data[si + 3]; n++;
        }
      }
      const di = (y * w + x) * 4;
      out[di] = r / n; out[di + 1] = g / n; out[di + 2] = b / n; out[di + 3] = a / n;
    }
  }
  return { data: out, width: w, height: h };
}

function downsampleDrawable(img: TexImageSource, W: number, H: number) {
  const scale = Math.min(1, FILL_EDGE / Math.max(W, H));
  const w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));
  const c: HTMLCanvasElement | OffscreenCanvas =
    typeof document !== "undefined"
      ? document.createElement("canvas")
      : new OffscreenCanvas(w, h);
  c.width = w; c.height = h;
  const ctx = c.getContext("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) return { data: new Uint8ClampedArray(w * h * 4), w, h };
  ctx.drawImage(img as CanvasImageSource, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, w, h };
}

// Downscale a drawable (ImageBitmap) so its long edge ≤ maxEdge before it is
// uploaded as a texture. Returns the input unchanged when it already fits. An
// oversized bitmap (a full-res camera JPEG on a small GPU) otherwise fails
// texImage2D and renders black; capping matches the float path. The GPU draw is
// a bilinear box-down (adequate for a display source, unlike the mip-tapped
// float path). Falls back to the original drawable if a 2D context is
// unavailable, so behaviour degrades to the previous (uncapped) upload.
function capDrawableToEdge(
  img: ImageBitmap,
  W: number,
  H: number,
  maxEdge: number,
): { source: TexImageSource; width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(W, H));
  if (scale >= 1) return { source: img, width: W, height: H };
  const w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));
  const c: HTMLCanvasElement | OffscreenCanvas =
    typeof document !== "undefined"
      ? document.createElement("canvas")
      : new OffscreenCanvas(w, h);
  c.width = w; c.height = h;
  const ctx = c.getContext("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) return { source: img, width: W, height: H };
  ctx.drawImage(img as CanvasImageSource, 0, 0, w, h);
  return { source: c, width: w, height: h };
}

/** Bind one value to a uniform by its declared GLSL type. mat3/mat4/sampler2D
 *  are not driven by the scalar param bag (samplers are bound by the prepass
 *  framework), so they're skipped here. */
function bindUniformByType(
  gl: WebGL2RenderingContext,
  loc: WebGLUniformLocation,
  type: GlslType,
  value: unknown,
): void {
  switch (type) {
    case "float": gl.uniform1f(loc, value as number); break;
    case "int": gl.uniform1i(loc, (value as number) | 0); break;
    case "bool": gl.uniform1i(loc, value ? 1 : 0); break;
    case "vec2": { const v = value as number[]; gl.uniform2f(loc, v[0], v[1]); break; }
    case "vec3": { const v = value as number[]; gl.uniform3f(loc, v[0], v[1], v[2]); break; }
    case "vec4": { const v = value as number[]; gl.uniform4f(loc, v[0], v[1], v[2], v[3]); break; }
    case "ivec2": { const v = value as number[]; gl.uniform2i(loc, v[0] | 0, v[1] | 0); break; }
    case "ivec3": { const v = value as number[]; gl.uniform3i(loc, v[0] | 0, v[1] | 0, v[2] | 0); break; }
    case "ivec4": { const v = value as number[]; gl.uniform4i(loc, v[0] | 0, v[1] | 0, v[2] | 0, v[3] | 0); break; }
    default: break;
  }
}

// A shown brush spot with strokes: the spots the retouch atlas bakes and
// render() binds a channel for. Both lists must come from this one check,
// since the channel is looked up by spot id and a spot only one side counts
// would read another spot's coverage.
function isVisibleBrushSpot(
  s: RetouchSpot,
): s is RetouchSpot & { dabs: NonNullable<RetouchSpot["dabs"]> } {
  return s.visible !== false && s.shape === "brush" && !!s.dabs && s.dabs.length > 0;
}

export type RenderCanvas = HTMLCanvasElement | OffscreenCanvas;

export interface WebGLRendererOpts {
  highBitDepth?: boolean;
  stages?: ProcessingStageContribution[];
  pipeline?: ResolvedPipeline;
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
  private curveTexture: WebGLTexture;
  // Per-mask tone-curve LUT atlas (256 x MAX_MASKS RGBA; one row per mask).
  private maskCurveTexture: WebGLTexture;
  private maskCurveAtlas = new Uint8Array(256 * MAX_MASKS * 4);
  private maskTexture: WebGLTexture;
  private maskSig = "";
  private maskChannelOf: Record<string, number> = {};
  private maskInputs = new CoverageInputs();
  private retouchTexture: WebGLTexture;
  private retouchSig = "";
  private retouchChannelOf: Record<string, number> = {};
  private retouchInputs = new CoverageInputs();
  // The patched copy of the source: the retouch baked in, mipmapped, and sampled
  // as uImage by a retouched frame's develop draws. Sized to the (capped) source;
  // lazily created on first heal.
  private developedTex: WebGLTexture | null = null;
  private developedFbo: WebGLFramebuffer | null = null;
  private devW = 0;
  private devH = 0;
  // The format developedTex is allocated in: the one the photo's process version
  // wants, or a fallback when that target isn't framebuffer-complete or can't be
  // mipmapped.
  private developedFormat: DevelopedFormat = "rgba8";
  // Whether the current norm16 or float16 allocation has mipmapped without a GL error.
  private developedMipsVerified = false;
  // Downscaled 8-bit sRGB copy of the source, forwarded to the main thread so the
  // heal-source picker (findHealSource/healColorOffset) has pixels to search.
  private healSig = "";
  private fillSrc: Uint8ClampedArray | null = null;
  private fillW = 0;
  private fillH = 0;
  // Small FBO for fast histogram computation (re-render at low res + readPixels).
  private histFbo: WebGLFramebuffer | null = null;
  private histTex: WebGLTexture | null = null;
  private histFboF: WebGLFramebuffer | null = null;
  private histTexF: WebGLTexture | null = null;
  // Display-space float histogram target: same output as the 8-bit standard
  // path, but read back as float so the 256 bins see continuous values instead
  // of 256 quantized codes (avoids the comb/banding artifact after tonal stretch).
  private histFboD: WebGLFramebuffer | null = null;
  private histTexD: WebGLTexture | null = null;
  private haveColorBufferFloat = false;
  // When set, render()'s final composite pass draws into this framebuffer instead
  // of the default (8-bit canvas). Used by captureFloatFrame for 16-bit export.
  private outputFbo: WebGLFramebuffer | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  // Extension-contributed stage uniforms (namespaced) and their live values.
  // Bindings are rebuilt whenever the stage set changes; values arrive via
  // setContributedParams (the develop store's generic param bag).
  private contributedBindings: ContributedBinding[] = [];
  private contributedParams: Record<string, unknown> = {};
  // Prepass stages whose program failed to compile/link this session — skipped
  // thereafter so one bad stage can't throw out of render() and freeze the view.
  private failedPrepass = new Set<string>();
  private warnedPrepassOverflow = new Set<string>();
  private warnedCoverageOverflow = new Set<string>();
  private warnedSplitFallback = new Set<string>();
  // True when the built-in denoise prepass produced a real float result this
  // frame (active, float targets, not failed). Drives uDenoiseReady so the
  // inline swap of `lin` never applies a raw fallback texture.
  private denoiseReady = false;
  // Extension stage textures: namespaced sampler bindings (rebuilt with the stage
  // set), the latest pixel data per qualified key, and the GPU textures we've
  // uploaded (cached by version so an unchanged stock isn't re-uploaded).
  private stageTextureBindings: StageTextureBinding[] = [];
  private stageTextures: Record<string, StageTextureData> = {};
  private uploadedStageTex = new Map<string, { tex: WebGLTexture; version: number }>();
  private dummyStageTex: WebGLTexture | null = null;
  // Multi-pass prepass framework: ping-pong float targets, per-stage result
  // textures, and cached pass programs (keyed by stageSig|stageId|passIdx).
  private prepassStages: PrepassStage[] = [];
  // True when a contributed noise-reduction stage is active → skip built-in NR.
  private hasContribNR = false;
  private ppTex: [WebGLTexture | null, WebGLTexture | null] = [null, null];
  private ppFbo: [WebGLFramebuffer | null, WebGLFramebuffer | null] = [null, null];
  private ppW = 0;
  private ppH = 0;
  private ppInternalFormat = 0; // gl.RGBA16F or gl.RGBA8
  private stageResultTargets = new Map<string, { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number }>();
  private passPrograms = new Map<string, { program: WebGLProgram; locs: Record<string, WebGLUniformLocation | null> }>();
  // Result texture + assigned texture unit per prepass stage, filled by
  // runPrepasses each frame and bound onto the main program before the draw.
  private prepassResults: { resultUniform: string; tex: WebGLTexture; unit: number }[] = [];
  // Per-stage signature of the last prepass run; lets runPrepasses skip the
  // (expensive) passes and reuse the cached result when nothing it depends on
  // (source, this stage's pass params, dims, linearization, and for a
  // reads-current stage its split token) changed — so editing unrelated
  // controls (exposure, etc.) doesn't recompute denoise.
  private prepassSigs = new Map<string, string>();
  // Tokens for the split part of a reads-current stage's prepass signature.
  private splitTokens = new SplitTokens();
  // Cumulative draws, for diagnostics and the cost tests.
  private draws = { split: 0, pass: 0 };
  // Bumped whenever the active source texture is swapped (setImage / bindSource).
  private sourceEpoch = 0;
  private params: DevelopParams | null = null;
  private asShotTemperature = 6500;
  // HSL band shaping (Preferences ▸ HSL). Default 1/1 reproduces the original
  // partition-of-unity smoothstep bands, so every render path (develop, export,
  // thumbnails) is unchanged until the develop view pushes the user's pref.
  private hslRange = 1;
  private hslSmooth = 1;
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
  private maxEdge = MAX_EDGE;
  // Output color space. Live develop/loupe/thumbnails stay sRGB (a no-op in the
  // shader); export sets a wider space so the encode + ICC match.
  private outSpace: ColorSpaceId = "srgb";
  private linear = false;
  private isFallbackPreview = false;
  private applyBaseCurve = false;
  // EXT_texture_norm16: lets the heal pass's developed target be a normalized,
  // GPU-mipmappable RGBA16 texture instead of RGBA8. 0 / false when the GPU
  // lacks it (or can't mipmap it) — the target then stays RGBA8.
  private haveNorm16 = false;
  private norm16Format = 0;
  // Whether a version 2 photo's developed target can be RGBA16F: float colour
  // buffers make it renderable, and so mipmappable, until this driver fails to
  // mipmap a full-size one.
  private haveFloat16Developed = false;
  // Active render pipeline + stage signatures + process version: compared on
  // every render to detect when another program is needed (pipeline change,
  // stage enable/disable, or a photo on another process version).
  private pipelineSig = "";
  private stageSig = "";
  private variant: ShaderVariant = V2_VARIANT;
  private pipelineSkipBase = false;
  private pipelineSkipShoulder = false;
  private programCache = new Map<string, PipelineProgram>();
  // The error each failed build threw, by program cache key (see entryFor).
  private failedBuilds = new Map<string, unknown>();
  private vao: WebGLVertexArrayObject | null = null;
  private quadBuf: WebGLBuffer | null = null;
  private injectedStages: ProcessingStageContribution[] | null = null;
  private injectedPipeline: ResolvedPipeline | null = null;
  // syncPipeline runs every frame. Rebuilding the injection re-namespaces every
  // stage's GLSL, so it happens only when the stage source changes: the registry
  // replaces its processingStages object on every change, and setStages drops
  // the memo, so an injected array edited in place is rebuilt too. Each process
  // version keeps its own build, so photos alternating between versions reuse
  // both.
  private injectionMemo: {
    source: readonly ProcessingStageContribution[] | Record<string, ProcessingStageContribution>;
    built: Map<ShaderVariant, BuiltStageInjection>;
  } | null = null;

  // ── GPU-resident source cache ──────────────────────────────────────────
  // Decoded sources kept resident keyed by sourceKey (photo id + decode variant)
  // so re-opening a photo or re-rendering its (edited) thumbnail reuses the
  // uploaded texture instead of decoding + uploading again. Bounded by a byte
  // budget with LRU eviction; the currently-bound source is pinned.
  private sourceCache = new Map<string, SourceEntry>();
  private currentSourceKey: string | null = null;
  // True while this.imageTexture is owned by the renderer (legacy setImage path)
  // rather than the cache. A cache-owned texture must not be deleted on the next
  // load or on dispose — the cache owns its lifetime.
  private imageTextureOwned = true;
  private cacheBudgetBytes = DEFAULT_SOURCE_CACHE_BYTES;
  private useTick = 0;
  // Bytes/px of the last setImage upload (8 for RGBA16F, 4 for RGBA8), so the
  // cache byte estimate reflects the format actually uploaded.
  private lastUploadBpp = 4;
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
    if (opts?.stages) this.injectedStages = opts.stages;
    if (opts?.pipeline) this.injectedPipeline = opts.pipeline;

    const highBitDepth = opts?.highBitDepth ?? getSettings().highBitDepth;
    const norm16 = highBitDepth
      ? gl.getExtension("EXT_texture_norm16")
      : null;
    if (norm16) {
      const fmt = (norm16 as { RGBA16_EXT: number }).RGBA16_EXT;
      const probe = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, probe);
      gl.texImage2D(gl.TEXTURE_2D, 0, fmt, 2, 2, 0, gl.RGBA, gl.UNSIGNED_SHORT,
        new Uint16Array(16));
      gl.generateMipmap(gl.TEXTURE_2D);
      const probeErr = gl.getError();
      gl.deleteTexture(probe);
      while (gl.getError() !== gl.NO_ERROR) {} // drain any trailing errors
      if (probeErr === gl.NO_ERROR) {
        this.haveNorm16 = true;
        this.norm16Format = fmt;
      }
      // else: norm16 extension exists but mipmap generation isn't supported on
      // this driver — the developed target falls back silently to RGBA8.
    }

    this.haveColorBufferFloat = !!gl.getExtension("EXT_color_buffer_float");
    this.haveFloat16Developed = this.haveColorBufferFloat;

    this.setupQuad();

    this.imageTexture = this.createTexture();
    this.curveTexture = gl.createTexture();
    this.initCurveTexture();
    this.maskCurveTexture = gl.createTexture();
    this.initMaskCurveTexture();
    this.maskTexture = gl.createTexture();
    this.retouchTexture = gl.createTexture();
    this.initCoverageTexture(this.maskTexture);
    this.initCoverageTexture(this.retouchTexture);
  }

  // Whether float color buffers are renderable (EXT_color_buffer_float). This one
  // flag governs the entire pipeline's working precision: when false, every
  // intermediate (ping-pong targets, histogram readback) is RGBA8, so even a
  // 16-bit source is crushed to 8 bits at the first pass and any tonal stretch
  // bands. Surfaced to the UI as a diagnostic.
  get colorBufferFloat(): boolean {
    return this.haveColorBufferFloat;
  }

  /** Cumulative split and pass draws since construction. */
  get renderDrawCounts(): { readonly split: number; readonly pass: number } {
    return { ...this.draws };
  }

  // 1x1 transparent default so a coverage sampler is always valid even with no
  // brush items present.
  private initCoverageTexture(tex: WebGLTexture) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
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
    if (sig === prevSig) return { sig, channelOf: tex === this.maskTexture ? this.maskChannelOf : this.retouchChannelOf };
    const baked = bakeCoverage(items, aspect);
    const gl = this.gl;
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
  // or qualified texture key. Signing the dabs is skipped unless an input was
  // replaced, so callers replace masks and bag values rather than editing them.
  // A bake that throws is tried again by the next call, whatever changed.
  private updateMaskTexture(masks: Mask[]) {
    const keys = this.coverageKeys();
    const inputs = [
      masks,
      this.imageWidth,
      this.imageHeight,
      this.stageTextureBindings,
      ...keys.map((k) => this.contributedParams[k]),
    ];
    this.maskInputs.bakeIfChanged(inputs, () => {
      const items: CoverageItem[] = [];
      for (const m of masks) {
        for (const c of m.components) {
          if (c.kind === "brush" && c.brush) items.push({ id: c.id, dabs: c.brush.dabs });
        }
      }
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

  private coverageKeys(): string[] {
    return this.stageTextureBindings
      .filter((b) => b.kind === "coverage")
      .map((b) => b.qualifiedKey);
  }

  private updateRetouchTexture(retouch: RetouchSpot[]) {
    this.retouchInputs.bakeIfChanged([retouch, this.imageWidth, this.imageHeight], () => {
      const items: CoverageItem[] = retouch
        .filter(isVisibleBrushSpot)
        .map((s) => ({ id: s.id, dabs: s.dabs }));
      const r = this.updateCoverageTexture(this.retouchTexture, items, this.retouchSig);
      this.retouchSig = r.sig;
      this.retouchChannelOf = r.channelOf;
    });
  }

  // Program + uniform locations for a pipeline + stage set + process version,
  // cached by combined signature. A bad custom transform falls back to the
  // built-in entry — cached under the failing sig too, so it isn't recompiled
  // (and re-logged) every frame. A build that throws is remembered under its key
  // and rethrown as it was, without compiling again, until a signature or the
  // version gives another key. The stage set comes in as an argument, not from the
  // renderer's own state, so building an entry never touches what it is drawing with.
  private entryFor(
    p: ResolvedPipeline,
    built: BuiltStageInjection,
    variant: ShaderVariant,
  ): PipelineProgram {
    const cacheKey = `${p.sig}|${built.sig}|${variantKey(variant)}`;
    const cached = this.programCache.get(cacheKey);
    if (cached) return cached;
    if (this.failedBuilds.has(cacheKey)) throw this.failedBuilds.get(cacheKey);
    try {
      const entry = this.buildEntry(p, built, variant);
      this.programCache.set(cacheKey, entry);
      return entry;
    } catch (err) {
      this.failedBuilds.set(cacheKey, err);
      throw err;
    }
  }

  private buildEntry(
    p: ResolvedPipeline,
    built: BuiltStageInjection,
    variant: ShaderVariant,
  ): PipelineProgram {
    try {
      const program = this.createProgram(
        VERTEX_SHADER,
        buildFragmentShader(p.glsl, built.injection, variant),
      );
      return {
        program,
        uniforms: this.cacheUniformsFor(program, built),
        skipBase: p.skipBaseCurve,
        skipShoulder: p.skipToneShoulder,
      };
    } catch (err) {
      if (!p.glsl) throw err; // built-in must compile
      console.error(`[pipeline] "${p.id}" failed to compile; using built-in:`, err);
      return this.entryFor(BUILTIN_RESOLVED, built, variant);
    }
  }

  private createProgram(vsSrc: string, fsSrc: string): WebGLProgram {
    const gl = this.gl;
    const vs = this.compileShader(gl.VERTEX_SHADER, vsSrc);
    let fs: WebGLShader;
    try {
      fs = this.compileShader(gl.FRAGMENT_SHADER, fsSrc);
    } catch (err) {
      // A contributed stage with bad GLSL fails here on every attempt (each
      // pipeline switch, each dev-folder reload), so the already-compiled
      // vertex shader must not be stranded on the way out.
      gl.deleteShader(vs);
      throw err;
    }
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    // Pin attribute locations so the shared quad VAO is valid for every
    // pipeline variant of the program.
    gl.bindAttribLocation(program, ATTR_POS, "aPos");
    gl.bindAttribLocation(program, ATTR_UV, "aUv");
    gl.linkProgram(program);
    // Attached shaders are freed with the program once flagged, so release them
    // before the link check — otherwise a link failure strands both.
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`Program link failed: ${log}`);
    }
    return program;
  }

  private compileShader(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Shader compile failed: ${log}`);
    }
    return shader;
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

  private cacheUniformsFor(
    program: WebGLProgram,
    built: BuiltStageInjection,
  ): Record<string, WebGLUniformLocation | null> {
    const gl = this.gl;
    const u: Record<string, WebGLUniformLocation | null> = {};
    const names = [
      "uImage",
      "uCurve",
      "uOutSpace",
      "uOutMatrix",
      "uCrop",
      "uInvTransform",
      "uOutsideColor",
      "uViewport",
      "uLinear",
      "uIsFallbackPreview",
      "uApplyBaseCurve",
      "uApplyToneShoulder",
      "uRawHistogram",
      "uShowClipping",
      "uVizMask",
      "uVizColor",
      "uVizStrength",
      "uSharpenViz",
      "uDenoiseReady",
      "uExposure",
      "uContrast",
      "uHighlights",
      "uShadows",
      "uWhites",
      "uBlacks",
      "uTexture",
      "uClarity",
      "uDehaze",
      "uHighlightDetail",
      "uShadowDetail",
      "uSharpening",
      "uSharpenRadius",
      "uSharpenDetail",
      "uSharpenMasking",
      "uLuminanceNR",
      "uSkipCoreNR",
      "uLumNRDetail",
      "uLumNRContrast",
      "uLumNRShadows",
      "uLumNRHighlights",
      "uColorNR",
      "uColorNRDetail",
      "uColorNRSmooth",
      "uVibrance",
      "uSaturation",
      "uTemperature",
      "uTint",
      "uAsShotTemperature",
      "uClipThreshold",
      "uHslHue",
      "uHslSat",
      "uHslLum",
      "uHslRange",
      "uHslSmooth",
      "uCGShadowHue",
      "uCGShadowSat",
      "uCGShadowLuma",
      "uCGMidHue",
      "uCGMidSat",
      "uCGMidLuma",
      "uCGHighHue",
      "uCGHighSat",
      "uCGHighLuma",
      "uCGGlobalHue",
      "uCGGlobalSat",
      "uCGGlobalLuma",
      "uCGShadowRange",
      "uCGHighlightRange",
      "uCurveActive",
      "uHslActive",
      "uColorGradingActive",
      // Effects: vignette
      "uVignetteAmount",
      "uVignetteMidpoint",
      "uVignetteRoundness",
      "uVignetteFeather",
      "uVignetteHighlights",
      // Effects: grain
      "uGrainAmount",
      "uGrainSize",
      "uGrainRoughness",
      "uGrainColor",
      // Masks + retouch
      "uImageAspect",
      "uMaskCount",
      "uMaskTex",
      "uMaskCurves",
      // Array bases set in one call via uniform*v.
      "uMaskHasHsl[0]",
      "uMaskHasCurve[0]",
      "uMaskHasDisplay[0]",
      "uMaskHsl[0]",
      "uSpotCount",
      "uRetouchTex",
      "uRetouchCount",
      "uDevelopedSrc",
      "uHaveDeveloped",
      "uApplyRetouch",
      "uMembraneHeal",
      "uPatchPass",
      "uSplitAt",
    ];
    // Per-mask array uniforms (queried by indexed name).
    for (let i = 0; i < MAX_MASKS; i++) {
      for (const base of ["uMaskInvert", "uMaskOpacity", "uMaskAdj0", "uMaskAdj1", "uMaskAdj2", "uMaskAdj3"]) {
        const name = `${base}[${i}]`;
        u[name] = gl.getUniformLocation(program, name);
      }
    }
    // Per-component array uniforms.
    u["uCompCount"] = gl.getUniformLocation(program, "uCompCount");
    for (let i = 0; i < MAX_MASK_COMPONENTS; i++) {
      for (const base of [
        "uCompMaskIdx", "uCompMode", "uCompType", "uCompInvert", "uCompBrushCh", "uCompGeoA", "uCompGeoB",
      ]) {
        const name = `${base}[${i}]`;
        u[name] = gl.getUniformLocation(program, name);
      }
    }
    for (let i = 0; i < MAX_RETOUCH; i++) {
      u[`uSpotA[${i}]`] = gl.getUniformLocation(program, `uSpotA[${i}]`);
      u[`uSpotB[${i}]`] = gl.getUniformLocation(program, `uSpotB[${i}]`);
      u[`uSpotC[${i}]`] = gl.getUniformLocation(program, `uSpotC[${i}]`);
      u[`uSpotTint[${i}]`] = gl.getUniformLocation(program, `uSpotTint[${i}]`);
    }
    for (let i = 0; i < MAX_RETOUCH_BRUSH; i++) {
      u[`uRetouchCh[${i}]`] = gl.getUniformLocation(program, `uRetouchCh[${i}]`);
      u[`uRetouchData[${i}]`] = gl.getUniformLocation(program, `uRetouchData[${i}]`);
    }
    for (const name of names) {
      u[name] = gl.getUniformLocation(program, name);
    }
    // Extension-contributed stage uniforms, keyed by qualified key so render()
    // can resolve location + value together from the param bag.
    for (const b of built.bindings) {
      u[b.qualifiedKey] = gl.getUniformLocation(program, b.glslName);
    }
    // Prepass result samplers (one per passes-bearing stage).
    for (const ps of built.prepass) {
      u[ps.resultUniform] = gl.getUniformLocation(program, ps.resultUniform);
    }
    // Extension stage-texture samplers / coverage channel uniforms, keyed by
    // qualified key.
    for (const tb of built.textureBindings) {
      const name = tb.kind === "coverage" ? `${tb.glslName}_ch` : tb.glslName;
      u[tb.qualifiedKey] = gl.getUniformLocation(program, name);
    }
    return u;
  }

  private createTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // Mipmaps give Texture/Clarity/Dehaze a cheap multi-scale blur (textureLod).
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      gl.LINEAR_MIPMAP_LINEAR,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private initCurveTexture() {
    const gl = this.gl;
    const identity = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      identity[i * 4] = i;
      identity[i * 4 + 1] = i;
      identity[i * 4 + 2] = i;
      identity[i * 4 + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.curveTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      256,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      identity,
    );
  }

  /** Largest edge this GL context can hold in a single texture. Callers that
   *  size full-resolution uploads (export at "Original") must stay under it —
   *  an oversized texImage2D fails and the frame renders black. */
  get maxTextureEdge(): number {
    return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
  }

  setImage(
    image:
      | ImageBitmap
      | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean }
      | { kind: "float16"; data: Uint16Array; width: number; height: number },
    maxEdge: number = MAX_EDGE,
    isFallbackPreview = false,
    // True when an 8-bit bitmap is actually a linear-encoded RAW source (the
    // cached develop preview) rather than a camera-rendered image. Such a source
    // still needs the default base tone curve, same as the live float decode.
    baseCurveForBitmap = false,
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
    this.imageTexture = this.createTexture();
    this.imageTextureOwned = true;
    this.currentSourceKey = null;
    this.sourceEpoch++;
    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
    if ("kind" in image) {
      // Linear float (RAW) path — upload as RGBA16F so the develop pipeline keeps
      // ~10-bit precision AND real HDR headroom. The previous code quantised to 8-bit
      // sRGB (mipmaps need a filterable+renderable format), which meant a +5 exposure
      // (×32) stretched ~50 code values across the bright sky into visible bands, and
      // because R/G/B quantise independently their ratios stepped → rainbow posterising.
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
      const cap = fromCache && !capFloat16 ? this.maxTextureEdge : maxEdge;
      const fimg = capFloatToEdge(src0, image.width, image.height, cap);
      this.imageWidth = fimg.width;
      this.imageHeight = fimg.height;
      this.lastUploadBpp = 8; // RGBA16F
      // Texture now holds true linear scene values, so the shader must NOT sRGB-decode.
      this.linear = true;
      this.isFallbackPreview = fromCache
        ? false
        : (image.isFallbackPreview ?? isFallbackPreview);
      // Real full-res RAW decode (not the pseudo-linear JPEG fallback) renders
      // scene-linear and flat; add the default tone curve to match other views.
      this.applyBaseCurve = !this.isFallbackPreview;
      const f0 = fimg.data;
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA16F, fimg.width, fimg.height, 0,
        gl.RGBA, gl.FLOAT, f0,
      );
      // Manual float mip chain (trilinear taps for Texture/Clarity/Dehaze/Sharpen).
      let lw = fimg.width, lh = fimg.height, lvl = 0, cur = f0;
      while (lw > 1 || lh > 1) {
        const ds = halveRGBAF(cur, lw, lh);
        lvl++; cur = ds.data; lw = ds.w; lh = ds.h;
        gl.texImage2D(gl.TEXTURE_2D, lvl, gl.RGBA16F, lw, lh, 0, gl.RGBA, gl.FLOAT, cur);
      }
      {
        // Heal source stays 8-bit sRGB (its own pipeline).
        const ds = healImageFromLinear(f0, fimg.width, fimg.height, FILL_EDGE);
        this.fillSrc = ds.data; this.fillW = ds.w; this.fillH = ds.h; this.healSig = "";
        setHealSourceImage(ds.data, ds.w, ds.h);
      }
    } else {
      // 8-bit sRGB bitmap path. Cap the upload to the develop edge (and never
      // above the GL max texture size) so an oversized bitmap can't fail
      // texImage2D into a black frame — the float path caps the same way.
      const cap = Math.min(maxEdge, this.maxTextureEdge);
      const capped = capDrawableToEdge(image, image.width, image.height, cap);
      this.imageWidth = capped.width;
      this.imageHeight = capped.height;
      this.lastUploadBpp = 4; // RGBA8
      this.linear = false;
      this.isFallbackPreview = isFallbackPreview;
      // Camera-rendered bitmaps already carry a tone curve; the cached develop
      // preview is linear-encoded RAW and needs the base curve added.
      this.applyBaseCurve = baseCurveForBitmap;
      // Orientation is handled by the vertex shader (V flip). Do NOT use
      // UNPACK_FLIP_Y_WEBGL: it is unreliable for ImageBitmap sources.
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, capped.source,
      );
      {
        const ds = downsampleDrawable(image, image.width, image.height);
        this.fillSrc = ds.data; this.fillW = ds.w; this.fillH = ds.h; this.healSig = "";
        setHealSourceImage(ds.data, ds.w, ds.h);
      }
      // Mip chain for the local-contrast blurs (Texture/Clarity/Dehaze); the
      // float path supplies its own by hand.
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    this.hasImage = true;
    this.resize();
  }

  // ── GPU-resident source cache ──────────────────────────────────────────

  /** Set the LRU byte budget; evicts immediately if already over. */
  setCacheBudget(bytes: number) {
    this.cacheBudgetBytes = Math.max(0, bytes);
    this.evictToBudget();
  }

  /** Is a decoded source for this key already resident? */
  hasSource(key: string): boolean {
    return this.sourceCache.has(key);
  }

  // Decode-and-upload a source under `key`, then bind it as active. Reuses the
  // full setImage upload path, then transfers ownership of the resulting texture
  // (plus its derived render state) into the cache so a later bindSource(key) is
  // a zero-decode swap.
  uploadSource(
    key: string,
    image:
      | ImageBitmap
      | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean }
      | { kind: "float16"; data: Uint16Array; width: number; height: number },
    maxEdge: number = MAX_EDGE,
    isFallbackPreview = false,
    baseCurveForBitmap = false,
    // When false, the source is uploaded into the cache but the previously-active
    // source is re-bound afterwards — used to prefetch neighbours without
    // disturbing the displayed image.
    bind = true,
    // Cap a cached float16 source to maxEdge (thumb renderer only — see setImage).
    capFloat16 = false,
  ) {
    const prevKey = this.currentSourceKey;
    // Drop any stale entry for this key (e.g. re-decode after an edit changed the
    // pixels) so we don't leak its texture.
    this.dropSource(key);
    this.setImage(image, maxEdge, isFallbackPreview, baseCurveForBitmap, capFloat16);
    // setImage built into this.imageTexture and marked it owned; hand it to the cache.
    const entry: SourceEntry = {
      tex: this.imageTexture,
      width: this.imageWidth,
      height: this.imageHeight,
      linear: this.linear,
      applyBaseCurve: this.applyBaseCurve,
      isFallbackPreview: this.isFallbackPreview,
      fill: this.fillSrc ? { data: this.fillSrc, w: this.fillW, h: this.fillH } : null,
      maxEdge: this.maxEdge, // setImage just set this from `maxEdge`
      bytes: this.estimateSourceBytes(this.imageWidth, this.imageHeight),
      lastUsed: ++this.useTick,
    };
    this.sourceCache.set(key, entry);
    this.imageTextureOwned = false; // the cache owns this texture now
    this.currentSourceKey = key;
    // Prefetch: restore the source that was active before so the display is
    // unchanged. No render() runs here, so nothing repaints in between.
    if (!bind && prevKey && prevKey !== key && this.sourceCache.has(prevKey)) {
      this.bindSource(prevKey);
    }
    this.evictToBudget();
  }

  // Bind a resident source as the active image without re-decoding. Returns false
  // if the key isn't cached (caller should decode + uploadSource). `maxEdge`
  // overrides the output-size cap for this bind (a thumb render caps the output
  // smaller than the source it uploaded); omit it to restore the source's own cap.
  bindSource(key: string, maxEdge?: number): boolean {
    const e = this.sourceCache.get(key);
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
    this.isFallbackPreview = e.isFallbackPreview;
    // Restore the heal source (the downscaled 8-bit copy) for this image; the
    // heal-source picker singleton is shared across images, so re-point it here.
    if (e.fill) {
      this.fillSrc = e.fill.data;
      this.fillW = e.fill.w;
      this.fillH = e.fill.h;
      setHealSourceImage(e.fill.data, e.fill.w, e.fill.h);
    } else {
      this.fillSrc = null;
    }
    this.healSig = "";
    e.lastUsed = ++this.useTick;
    this.currentSourceKey = key;
    this.hasImage = true;
    this.resize();
    return true;
  }

  private dropSource(key: string) {
    const e = this.sourceCache.get(key);
    if (!e) return;
    // If the entry's texture is currently bound, detach it first so we don't free
    // it out from under the active view; mark the slot owned so it's cleaned up
    // normally on the next load.
    if (this.currentSourceKey === key) {
      this.imageTextureOwned = true; // adopt: it's about to stop being a cache tex
      this.currentSourceKey = null;
    } else {
      this.gl.deleteTexture(e.tex);
    }
    this.sourceCache.delete(key);
  }

  private estimateSourceBytes(w: number, h: number): number {
    // RGBA16F (float RAW, fresh or cached) = 8 bytes/px; 8-bit bitmap = 4 — the
    // format the upload actually took. ×4/3 accounts for the mip chain.
    return Math.round(w * h * this.lastUploadBpp * (4 / 3));
  }

  private evictToBudget() {
    let total = 0;
    for (const e of this.sourceCache.values()) total += e.bytes;
    if (total <= this.cacheBudgetBytes) return;
    // Evict least-recently-used first; never evict the pinned (bound) source.
    const ordered = [...this.sourceCache.entries()].sort(
      (a, b) => a[1].lastUsed - b[1].lastUsed,
    );
    for (const [key, e] of ordered) {
      if (total <= this.cacheBudgetBytes) break;
      if (key === this.currentSourceKey) continue;
      this.gl.deleteTexture(e.tex);
      this.sourceCache.delete(key);
      total -= e.bytes;
    }
  }

  // ── Viewport (zoom ROI) ────────────────────────────────────────────────

  // Render only `roi` (a window into the displayed image, normalized [0,1]) into
  // an output sized to outW×outH. Pass null to return to the whole-frame, crop-
  // capped sizing. Used by a zoomed Develop/Loupe view to draw the visible region
  // at screen resolution from the resident full-res source.
  setViewport(
    roi: { x: number; y: number; w: number; h: number } | null,
    outW?: number,
    outH?: number,
  ) {
    this.roi = roi;
    this.roiOut = roi && outW && outH ? { w: Math.max(1, Math.round(outW)), h: Math.max(1, Math.round(outH)) } : null;
  }

  // Size the output canvas to the cropped region (capped at maxEdge). Driven by
  // both setImage and setParams, since the crop lives in the develop params.
  private resize() {
    if (!this.imageWidth || !this.imageHeight) return;
    const crop = this.params?.crop ?? DEFAULT_CROP;
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
    const longEdge = Math.max(cw, ch);
    const scale = longEdge > 0 ? Math.min(1, this.maxEdge / longEdge) : 1;
    const w = Math.max(1, Math.round(cw * scale));
    const h = Math.max(1, Math.round(ch * scale));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.gl.viewport(0, 0, w, h);
  }

  private initMaskCurveTexture() {
    const gl = this.gl;
    for (let m = 0; m < MAX_MASKS; m++)
      for (let i = 0; i < 256; i++) {
        const o = (m * 256 + i) * 4;
        this.maskCurveAtlas[o] = i;
        this.maskCurveAtlas[o + 1] = i;
        this.maskCurveAtlas[o + 2] = i;
        this.maskCurveAtlas[o + 3] = 255;
      }
    gl.bindTexture(gl.TEXTURE_2D, this.maskCurveTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, MAX_MASKS, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.maskCurveAtlas);
  }

  // Rebuild rows for masks carrying a non-default curve. Rows are left as
  // written previously when a curve goes away — uMaskHasCurve gates sampling.
  private updateMaskCurveTexture(masks: Mask[]) {
    let any = false;
    masks.slice(0, MAX_MASKS).forEach((m, i) => {
      if (m.toneCurve && !isDefaultToneCurves(m.toneCurve)) {
        buildMaskCurveLUT(m.toneCurve, this.maskCurveAtlas, i * 256 * 4);
        any = true;
      }
    });
    if (!any) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.maskCurveTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, MAX_MASKS, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.maskCurveAtlas);
  }

  // Output color space for subsequent renders. Default sRGB matches the screen;
  // export uses this to convert pixels (and pairs it with an embedded ICC).
  get bufferWidth(): number { return this.canvas.width; }
  get bufferHeight(): number { return this.canvas.height; }

  setOutputColorSpace(space: ColorSpaceId) {
    this.outSpace = space;
  }

  setAsShotTemperature(kelvin: number) {
    this.asShotTemperature = kelvin >= 2000 && kelvin <= 50000 ? kelvin : 6500;
  }

  // Global HSL band shaping from Preferences ▸ HSL. range scales band half-widths
  // (clamped 0.25..2), smooth blends linear↔smoothstep falloff (0..1).
  setHslStyle(range: number, smooth: number) {
    this.hslRange = Number.isFinite(range) ? Math.min(2, Math.max(0.25, range)) : 1;
    this.hslSmooth = Number.isFinite(smooth) ? Math.min(1, Math.max(0, smooth)) : 1;
  }

  setShowClipping(mode: number) {
    this.showClipping = mode & 3;
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

  setParams(params: DevelopParams) {
    this.params = params;
    this.updateMaskTexture(params.masks);
    this.updateMaskCurveTexture(params.masks);
    this.updateRetouchTexture(params.retouch);
    this.uploadCurveLUT();
    // NOTE: resize happens in render(), not here. Resizing the canvas clears
    // it, and setParams runs a frame before the coalesced render — doing it
    // here painted a black frame on every crop/straighten/transform change.
  }

  // Rebuild + upload the composed tone-curve LUT: the user's curves only. The
  // baseline look is baselineTone in the shader, gated per source and pipeline
  // by uApplyBaseCurve, so the LUT never depends on the active transform.
  private uploadCurveLUT() {
    if (!this.params) return;
    const lut = buildRGBCurveLUT(this.params.toneCurve);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.curveTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      256,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      lut,
    );
  }

  // The 8-bit sRGB downscaled source used for heal source-picking. The heal
  // source/colour search (findHealSource/healColorOffset) runs on the MAIN
  // thread (in the overlay), so the worker forwards this buffer up after every
  // source change; without it the main-thread search has no pixels and silently
  // falls back to a blind offset (heal then copies near-identical neighbours and
  // appears to do nothing). Returns a copy so the caller can transfer/clone it.
  healSourceData(): { data: Uint8ClampedArray; w: number; h: number } | null {
    if (!this.fillSrc || this.fillW === 0 || this.fillH === 0) return null;
    return { data: new Uint8ClampedArray(this.fillSrc), w: this.fillW, h: this.fillH };
  }

  setStages(stages: ProcessingStageContribution[]) {
    this.injectedStages = stages;
    this.injectionMemo = null;
  }

  /** Generic param bag driving extension-contributed stage uniforms, keyed by
   *  qualified key "{stageId}.{key}". Unknown keys are simply never looked up;
   *  a stage uniform with no entry falls back to its declared default. */
  setContributedParams(bag: Record<string, unknown>) {
    this.contributedParams = bag;
  }

  /** Latest pixel data for extension stage textures, keyed by qualified key.
   *  Uploaded lazily at draw time; an unchanged `version` is a no-op. */
  setStageTextures(bag: Record<string, StageTextureData>) {
    this.stageTextures = bag;
  }

  /** A 1×1 opaque-black texture bound to any stage sampler that has no data yet,
   *  so the sampler always points at a complete texture. */
  private ensureDummyStageTex(): WebGLTexture {
    const gl = this.gl;
    if (this.dummyStageTex) return this.dummyStageTex;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.dummyStageTex = tex;
    return tex;
  }

  /** Upload (or reuse) the GPU texture for a stage texture by qualified key.
   *  Re-uploads only when the supplied `version` changes. */
  private ensureStageTexture(qk: string): WebGLTexture {
    const gl = this.gl;
    const data = this.stageTextures[qk];
    if (!data) return this.ensureDummyStageTex();
    const cached = this.uploadedStageTex.get(qk);
    if (cached && cached.version === data.version) return cached.tex;
    const tex = cached?.tex ?? gl.createTexture()!;
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
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.uploadedStageTex.set(qk, { tex, version: data.version });
    return tex;
  }

  setActivePipeline(pipeline: ResolvedPipeline) {
    this.injectedPipeline = pipeline;
  }

  /** Build the develop program for a process version under the pipeline and stages
   *  the renderer holds now, so its first frame finds it built. Throws what a frame
   *  would throw for a program that can't be built. It writes only to the renderer's
   *  caches (programs, remembered failures, stage injections), never to the stage
   *  set, pipeline or bindings it draws with. Whoever creates a renderer calls this
   *  to fail there, ahead of any frame, rather than out of render(). */
  prepareProgram(processVersion: number): void {
    const variant = shaderVariantFor(processVersion);
    const pipeline = this.injectedPipeline ?? resolveDefaultPipeline();
    this.entryFor(pipeline, this.stageInjection(variant), variant);
  }

  /** Build the stock develop program for a process version: the built-in transform
   *  with Safelight's own stages from the stage set the renderer holds (the core
   *  ones and the built-in denoiser) and nothing an extension contributes. It fails
   *  only where this machine can't run Safelight's own shader; stages or a transform
   *  from an extension can fail without it. It writes only to the same caches as
   *  prepareProgram. A caller whose prepareProgram threw uses it to tell the two
   *  cases apart. */
  prepareStockProgram(processVersion: number): void {
    const variant = shaderVariantFor(processVersion);
    const builtIn = this.currentStages().filter(isBuiltInStage);
    this.entryFor(BUILTIN_RESOLVED, buildStageInjection(builtIn, variant), variant);
  }

  private currentStages(): readonly ProcessingStageContribution[] {
    const source = this.injectedStages ?? useRegistry.getState().processingStages;
    return Array.isArray(source) ? source : Object.values(source);
  }

  private stageInjection(variant: ShaderVariant): BuiltStageInjection {
    const source = this.injectedStages ?? useRegistry.getState().processingStages;
    let memo = this.injectionMemo;
    if (memo?.source !== source) {
      memo = { source, built: new Map() };
      this.injectionMemo = memo;
    }
    let built = memo.built.get(variant);
    if (!built) {
      built = buildStageInjection(this.currentStages(), variant);
      memo.built.set(variant, built);
    }
    return built;
  }

  private syncPipeline() {
    const p = this.injectedPipeline ?? resolveDefaultPipeline();
    const variant = this.params ? shaderVariantFor(this.params.processVersion) : this.variant;
    const built = this.stageInjection(variant);
    const unchanged =
      p.sig === this.pipelineSig && built.sig === this.stageSig && variant === this.variant;
    // The stock transform and an empty stage set both sign as "", and the variant
    // starts at version 2, so a fresh renderer can already match its first frame:
    // equal signatures only mean "built" once a program exists.
    if (this.program && unchanged) return;
    // The renderer changes only once the program is in hand: a build that throws
    // leaves it on the stage set it was drawing with, so switching back to that set
    // finds its own bindings, not the failed set's.
    const e = this.entryFor(p, built, variant);
    // Pass programs are keyed by stageSig; a stage-set change invalidates them
    // and the prepass result cache. No process version changes stageSig, so a
    // photo on the other version keeps both.
    if (built.sig !== this.stageSig) {
      for (const pass of this.passPrograms.values()) this.gl.deleteProgram(pass.program);
      this.passPrograms.clear();
      this.prepassSigs.clear();
      this.splitTokens.clear();
      // A stage whose GLSL was fixed (extension update / dev-folder reload) gets a
      // fresh compile attempt; without this it stays disabled for the session.
      this.failedPrepass.clear();
    }
    this.contributedBindings = built.bindings;
    this.stageTextureBindings = built.textureBindings;
    this.prepassStages = built.prepass;
    this.hasContribNR = built.hasNoiseReduction;
    this.program = e.program;
    this.uniforms = e.uniforms;
    this.pipelineSkipBase = e.skipBase;
    this.pipelineSkipShoulder = e.skipShoulder;
    this.pipelineSig = p.sig;
    this.stageSig = built.sig;
    this.variant = variant;
  }

  // The program syncPipeline() last selected. Every draw path syncs first, so a
  // null here is a bug; drawing without a program only raises a GL error and
  // leaves the frame blank, which is why this throws instead.
  private developProgram(): WebGLProgram {
    if (!this.program) throw new Error("WebGLRenderer: drew before syncPipeline() built a program");
    return this.program;
  }

  render() {
    if (!this.hasImage || !this.params) return;
    this.syncPipeline();
    this.resize();
    const gl = this.gl;
    const p = this.params;
    const u = this.uniforms;

    // The atlases depend on the source's aspect, and the mask atlas on the bag
    // (coverage-kind stage textures) as well as the params. setParams can run
    // before either arrives — fold them in here.
    this.updateMaskTexture(p.masks);
    this.updateRetouchTexture(p.retouch);

    gl.useProgram(this.developProgram());

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
    gl.uniform1i(u.uImage, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.curveTexture);
    gl.uniform1i(u.uCurve, 1);

    gl.uniform1i(u.uOutSpace, OUT_SPACE_CODE[this.outSpace]);
    gl.uniformMatrix3fv(u.uOutMatrix, false, outMatrixColumnMajor(this.outSpace));

    gl.uniform1i(u.uLinear, this.linear ? 1 : 0);
    gl.uniform1i(u.uIsFallbackPreview, this.isFallbackPreview ? 1 : 0);
    // A replacement pipeline that brings its own look (AgX, ACES, …) can drop
    // the default RAW base curve and, separately, the core tone shoulder.
    gl.uniform1i(
      u.uApplyBaseCurve,
      this.applyBaseCurve && !this.pipelineSkipBase ? 1 : 0,
    );
    gl.uniform1i(u.uApplyToneShoulder, this.pipelineSkipShoulder ? 0 : 1);
    gl.uniform1i(u.uShowClipping, this.showClipping);
    gl.uniform3f(u.uOutsideColor, this.outsideColor[0], this.outsideColor[1], this.outsideColor[2]);
    gl.uniform1i(u.uVizMask, this.vizMask);
    gl.uniform3f(u.uVizColor, this.vizColor[0], this.vizColor[1], this.vizColor[2]);
    gl.uniform1f(u.uVizStrength, this.vizStrength);
    gl.uniform1i(u.uSharpenViz, this.sharpenViz);
    // GLSL zero-initialises uniforms, and 0 is a valid split index: every
    // draw but a split's must run with -1.
    gl.uniform1i(u.uSplitAt, -1);
    gl.uniform1f(u.uExposure, p.exposure);
    gl.uniform1f(u.uContrast, p.contrast);
    gl.uniform1f(u.uHighlights, p.highlights);
    gl.uniform1f(u.uShadows, p.shadows);
    gl.uniform1f(u.uWhites, p.whites);
    gl.uniform1f(u.uBlacks, p.blacks);
    gl.uniform1f(u.uTexture, p.texture);
    gl.uniform1f(u.uClarity, p.clarity);
    gl.uniform1f(u.uDehaze, p.dehaze);
    gl.uniform1f(u.uHighlightDetail, p.highlightDetail);
    gl.uniform1f(u.uShadowDetail, p.shadowDetail);
    gl.uniform1f(u.uSharpening, p.sharpening);
    gl.uniform1f(u.uSharpenRadius, p.sharpenRadius);
    gl.uniform1f(u.uSharpenDetail, p.sharpenDetail);
    gl.uniform1f(u.uSharpenMasking, p.sharpenMasking);
    gl.uniform1f(u.uLuminanceNR, p.luminanceNR);
    gl.uniform1i(u.uSkipCoreNR, this.hasContribNR ? 1 : 0);
    gl.uniform1f(u.uLumNRDetail, p.luminanceNRDetail);
    gl.uniform1f(u.uLumNRContrast, p.luminanceNRContrast);
    gl.uniform1f(u.uLumNRShadows, p.luminanceNRShadows);
    gl.uniform1f(u.uLumNRHighlights, p.luminanceNRHighlights);
    gl.uniform1f(u.uColorNR, p.colorNR);
    gl.uniform1f(u.uColorNRDetail, p.colorNRDetail);
    gl.uniform1f(u.uColorNRSmooth, p.colorNRSmoothness);
    gl.uniform1f(u.uVibrance, p.vibrance);
    gl.uniform1f(u.uSaturation, p.saturation);
    gl.uniform1f(u.uTemperature, p.temperature);
    gl.uniform1f(u.uTint, p.tint);
    gl.uniform1f(u.uAsShotTemperature, this.asShotTemperature);
    gl.uniform1f(u.uHslRange, this.hslRange);
    gl.uniform1f(u.uHslSmooth, this.hslSmooth);
    gl.uniform1f(u.uClipThreshold, this.linear ? 0.98 : 0.0);

    const crop = p.crop ?? DEFAULT_CROP;
    gl.uniform4f(u.uCrop, crop.x, crop.y, crop.width, crop.height);
    const vp = this.roi;
    gl.uniform4f(u.uViewport, vp ? vp.x : 0, vp ? vp.y : 0, vp ? vp.w : 1, vp ? vp.h : 1);
    const aspect = this.imageHeight > 0 ? this.imageWidth / this.imageHeight : 1;
    gl.uniformMatrix3fv(
      u.uInvTransform,
      false,
      mat3ColumnMajor(buildInverseTransform(p.straighten, p.transform, aspect)),
    );

    gl.uniform1fv(
      u.uHslHue,
      HSL_CHANNELS.map((ch) => p.hsl.hue[ch] / 100),
    );
    gl.uniform1fv(
      u.uHslSat,
      HSL_CHANNELS.map((ch) => p.hsl.saturation[ch] / 100),
    );
    gl.uniform1fv(
      u.uHslLum,
      HSL_CHANNELS.map((ch) => p.hsl.luminance[ch] / 100),
    );

    const cg = p.colorGrading;
    gl.uniform1f(u.uCGShadowHue,      cg.shadows.hue);
    gl.uniform1f(u.uCGShadowSat,      cg.shadows.sat);
    gl.uniform1f(u.uCGShadowLuma,     cg.shadows.luma);
    gl.uniform1f(u.uCGMidHue,         cg.midtones.hue);
    gl.uniform1f(u.uCGMidSat,         cg.midtones.sat);
    gl.uniform1f(u.uCGMidLuma,        cg.midtones.luma);
    gl.uniform1f(u.uCGHighHue,        cg.highlights.hue);
    gl.uniform1f(u.uCGHighSat,        cg.highlights.sat);
    gl.uniform1f(u.uCGHighLuma,       cg.highlights.luma);
    gl.uniform1f(u.uCGGlobalHue,      cg.global.hue);
    gl.uniform1f(u.uCGGlobalSat,      cg.global.sat);
    gl.uniform1f(u.uCGGlobalLuma,     cg.global.luma);
    gl.uniform1f(u.uCGShadowRange,    cg.shadowRange / 100);
    gl.uniform1f(u.uCGHighlightRange, cg.highlightRange / 100);
    // Version 2 skips these tools at identity. Version 1 programs have no
    // such uniforms, and GL ignores a null location.
    gl.uniform1i(u.uCurveActive, isDefaultToneCurves(p.toneCurve) ? 0 : 1);
    gl.uniform1i(u.uHslActive, isDefaultHSL(p.hsl) ? 0 : 1);
    gl.uniform1i(u.uColorGradingActive, isNeutralColorGrading(cg) ? 0 : 1);

    const vig = p.vignette;
    if (u.uVignetteAmount != null) {
      gl.uniform1f(u.uVignetteAmount,    vig.amount);
      gl.uniform1f(u.uVignetteMidpoint,  vig.midpoint);
      gl.uniform1f(u.uVignetteRoundness, vig.roundness);
      gl.uniform1f(u.uVignetteFeather,   vig.feather);
      gl.uniform1f(u.uVignetteHighlights,vig.highlights);
    }

    const gr = p.grain;
    if (u.uGrainAmount != null) {
      gl.uniform1f(u.uGrainAmount,    gr.amount);
      gl.uniform1f(u.uGrainSize,      gr.size);
      gl.uniform1f(u.uGrainRoughness, gr.roughness);
      gl.uniform1f(u.uGrainColor,     gr.color);
    }

    // Extension-contributed stage uniforms, driven by the generic param bag.
    // Uniforms persist on the program, so binding here once (before the draw
    // passes below) covers both the single-pass and retouch two-pass paths.
    for (const b of this.contributedBindings) {
      const loc = u[b.qualifiedKey];
      if (loc == null) continue;
      const value = this.contributedParams[b.qualifiedKey] ?? b.default;
      bindUniformByType(gl, loc, b.glslType, value);
    }

    // Extension stage textures (baked LUT atlases). Bound to units 12.. (above
    // the fixed 0-7 and prepass 8-11 ranges), so they stay resident through the
    // mask/retouch binds below and the draw passes. Like the scalar uniforms,
    // the sampler binding persists on the program across both draw paths.
    {
      let unit = STAGE_TEX_UNIT_BASE;
      for (const tb of this.stageTextureBindings) {
        if (tb.kind === "coverage") continue;
        if (unit >= STAGE_TEX_UNIT_BASE + MAX_STAGE_TEXTURES) break;
        const loc = u[tb.qualifiedKey];
        if (loc == null) continue;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, this.ensureStageTexture(tb.qualifiedKey));
        gl.uniform1i(loc, unit);
        unit++;
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

    const masks = p.masks.slice(0, MAX_MASKS);
    gl.uniform1i(u.uMaskCount, masks.length);
    masks.forEach((m, i) => {
      gl.uniform1i(u[`uMaskInvert[${i}]`], m.invert ? 1 : 0);
      // Hidden masks apply no adjustment (opacity 0) but still compute coverage,
      // so the coverage overlay can preview them. Coverage is sampled pre-opacity.
      gl.uniform1f(u[`uMaskOpacity[${i}]`], m.visible === false ? 0 : m.opacity / 100);
      const a: MaskAdjustments = m.adj;
      gl.uniform4f(u[`uMaskAdj0[${i}]`], a.exposure, a.contrast, a.highlights, a.shadows);
      gl.uniform4f(u[`uMaskAdj1[${i}]`], a.saturation, a.temperature, a.tint, a.clarity);
      gl.uniform4f(u[`uMaskAdj2[${i}]`], a.sharpness, a.whites, a.blacks, a.vibrance);
      gl.uniform4f(u[`uMaskAdj3[${i}]`], a.texture, a.dehaze, 0, 0);
    });

    // Flatten components across masks into the flat shader list (cap at the
    // shader's MAX_COMPONENTS). Each entry is tagged with its parent mask index.
    let ci = 0;
    for (let mi = 0; mi < masks.length && ci < MAX_MASK_COMPONENTS; mi++) {
      for (const c of masks[mi].components) {
        if (ci >= MAX_MASK_COMPONENTS) break;
        const type =
          c.kind === "linear" ? 0
          : c.kind === "radial" ? 1
          : c.kind === "lumRange" ? 3
          : c.kind === "colorRange" ? 4
          : 2; // brush
        const mode = c.mode === "subtract" ? 1 : c.mode === "intersect" ? 2 : 0;
        gl.uniform1i(u[`uCompMaskIdx[${ci}]`], mi);
        gl.uniform1i(u[`uCompMode[${ci}]`], mode);
        gl.uniform1i(u[`uCompType[${ci}]`], type);
        gl.uniform1i(u[`uCompInvert[${ci}]`], c.invert ? 1 : 0);
        gl.uniform1i(u[`uCompBrushCh[${ci}]`], this.maskChannelOf[c.id] ?? -1);
        if (c.kind === "linear" && c.linear) {
          gl.uniform4f(u[`uCompGeoA[${ci}]`], c.linear.x0, c.linear.y0, c.linear.x1, c.linear.y1);
          gl.uniform4f(u[`uCompGeoB[${ci}]`], 0, 0, 0, 0);
        } else if (c.kind === "radial" && c.radial) {
          gl.uniform4f(u[`uCompGeoA[${ci}]`], c.radial.cx, c.radial.cy, c.radial.rx, c.radial.ry);
          gl.uniform4f(u[`uCompGeoB[${ci}]`], c.radial.feather, c.radial.angle, 0, 0);
        } else if (c.kind === "lumRange" && c.lumRange) {
          const lr = c.lumRange;
          gl.uniform4f(u[`uCompGeoA[${ci}]`], lr.lo, lr.hi, lr.loFeather, lr.hiFeather);
          gl.uniform4f(u[`uCompGeoB[${ci}]`], 0, 0, 0, 0);
        } else if (c.kind === "colorRange" && c.colorRange) {
          const cr = c.colorRange;
          gl.uniform4f(u[`uCompGeoA[${ci}]`], cr.r, cr.g, cr.b, cr.hueRange);
          gl.uniform4f(u[`uCompGeoB[${ci}]`], cr.satRange, cr.smoothness, 0, 0);
        } else {
          gl.uniform4f(u[`uCompGeoA[${ci}]`], 0, 0, 0, 0);
          gl.uniform4f(u[`uCompGeoB[${ci}]`], 0, 0, 0, 0);
        }
        ci++;
      }
    }
    gl.uniform1i(u.uCompCount, ci);

    // Optional per-mask sub-panels: HSL packed as 6 vec4s per mask; curve flag
    // selects the atlas row.
    const hasHsl = new Int32Array(MAX_MASKS);
    const hasCurve = new Int32Array(MAX_MASKS);
    const hasDisplay = new Int32Array(MAX_MASKS);
    const hslData = new Float32Array(MAX_MASKS * 24);
    masks.forEach((m, i) => {
      if (maskHasDisplayAdjustments(m.adj)) hasDisplay[i] = 1;
      if (m.toneCurve && !isDefaultToneCurves(m.toneCurve)) hasCurve[i] = 1;
      if (m.hsl && !isDefaultHSL(m.hsl)) {
        hasHsl[i] = 1;
        const base = i * 24;
        HSL_CHANNELS.forEach((ch, b) => {
          hslData[base + b] = m.hsl!.hue[ch] / 100;
          hslData[base + 8 + b] = m.hsl!.saturation[ch] / 100;
          hslData[base + 16 + b] = m.hsl!.luminance[ch] / 100;
        });
      }
    });
    gl.uniform1iv(u["uMaskHasHsl[0]"], hasHsl);
    gl.uniform1iv(u["uMaskHasCurve[0]"], hasCurve);
    gl.uniform1iv(u["uMaskHasDisplay[0]"], hasDisplay);
    gl.uniform4fv(u["uMaskHsl[0]"], hslData);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.maskCurveTexture);
    gl.uniform1i(u.uMaskCurves, 6);

    // Circular spots -> parametric array; brush-shaped retouch -> coverage atlas.
    // Filter out hidden spots before uploading.
    const visibleSpots = p.retouch.filter((s) => s.visible !== false);
    const circles = visibleSpots.filter((s) => s.shape !== "brush").slice(0, MAX_RETOUCH);
    gl.uniform1i(u.uSpotCount, circles.length);
    circles.forEach((s, i) => {
      gl.uniform4f(u[`uSpotA[${i}]`], s.dstX, s.dstY, s.srcX, s.srcY);
      gl.uniform4f(
        u[`uSpotB[${i}]`],
        s.radius,
        s.feather / 100,
        s.opacity / 100,
        s.mode === "clone" ? 0 : 1, // heal flag: drives the membrane blend
      );
      const angle = s.angle ?? 0;
      const scale = s.scale ?? 1;
      gl.uniform4f(
        u[`uSpotC[${i}]`],
        Math.cos(angle),
        Math.sin(angle),
        1 / (scale || 1),
        0,
      );
      // Clone mode: zero the tint so source pixels are copied verbatim.
      const isClone = s.mode === "clone";
      gl.uniform4f(
        u[`uSpotTint[${i}]`],
        isClone ? 0 : (s.recolorR ?? 0),
        isClone ? 0 : (s.recolorG ?? 0),
        isClone ? 0 : (s.recolorB ?? 0),
        0,
      );
    });

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.retouchTexture);
    gl.uniform1i(u.uRetouchTex, 3);
    const brushSpots = p.retouch.filter(isVisibleBrushSpot).slice(0, MAX_RETOUCH_BRUSH);
    gl.uniform1i(u.uRetouchCount, brushSpots.length);
    brushSpots.forEach((s, i) => {
      gl.uniform1i(u[`uRetouchCh[${i}]`], this.retouchChannelOf[s.id] ?? 0);
      gl.uniform4f(
        u[`uRetouchData[${i}]`],
        s.srcX - s.dstX, // source offset, UV
        s.srcY - s.dstY,
        s.opacity / 100,
        0,
      );
    });

    gl.uniform1i(u.uMembraneHeal, MEMBRANE_HEAL ? 1 : 0);
    gl.uniform1i(u.uHaveDeveloped, 0);

    // Keep unit 4 (uDevelopedSrc) pointed at a valid texture.
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
    gl.uniform1i(u.uDevelopedSrc, 4);

    const hasRetouch = circles.length > 0 || brushSpots.length > 0;
    // The patched source depends on every circle spot's geometry/source/recolour,
    // not just the brush coverage captured by retouchSig. Without this, editing a
    // circle heal doesn't bust the prepass cache (e.g. denoise), so the patched
    // result stays stale until an app restart clears stageResultTargets.
    const circleSig = circles
      .map(
        (s) =>
          `${s.dstX.toFixed(4)},${s.dstY.toFixed(4)},${s.srcX.toFixed(4)},${s.srcY.toFixed(4)},` +
          `${s.radius.toFixed(4)},${s.feather},${s.opacity},${(s.angle ?? 0).toFixed(3)},${(s.scale ?? 1).toFixed(3)},` +
          `${(s.recolorR ?? 0).toFixed(3)},${(s.recolorG ?? 0).toFixed(3)},${(s.recolorB ?? 0).toFixed(3)},${s.mode}`,
      )
      .join(";");
    const patched =
      hasRetouch && this.prepareDevelopedTarget() && this.bakePatchedSource();
    if (patched) {
      // Prepasses (e.g. denoise) read the PATCHED source so heal happens before
      // detail; results are bound onto the main program for pass 2. The patched
      // source varies with retouch/heal geometry, so fold those into the cache key,
      // and with the process version and the copy's format, which decide what it
      // clips: a photo on the other version must not reuse this one's result.
      this.runPrepasses(
        this.developedTex!,
        `e${this.sourceEpoch}|r${this.retouchSig}|c${circleSig}|h${this.healSig}` +
          `|${variantKey(this.variant)}:${this.developedFormat}`,
        false,
        p,
      );
      // Pass 2 -> develop from the patched copy (now the spot is already gone,
      // so texture/clarity/sharpening can't invert it). Retouch off this pass.
      this.drawDevelop(this.developedTex!, false, this.outputTarget());
    } else {
      // No retouch (or no offscreen target): single pass. The in-shader retouch
      // is the fallback when the framebuffer can't be created.
      this.runPrepasses(this.imageTexture, `e${this.sourceEpoch}`, hasRetouch, p);
      this.drawDevelop(this.imageTexture, hasRetouch, this.outputTarget());
    }
  }

  private outputTarget(): DrawTarget {
    return { fbo: this.outputFbo, w: this.canvas.width, h: this.canvas.height };
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
    if (!this.hasImage || !this.params || !this.haveColorBufferFloat) return null;
    const gl = this.gl;
    // Size the canvas/viewport exactly as a normal render would (crop-capped).
    this.syncPipeline();
    this.resize();
    const w = this.canvas.width;
    const h = this.canvas.height;

    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!complete) {
      gl.deleteFramebuffer(fbo);
      gl.activeTexture(gl.TEXTURE7);
      gl.deleteTexture(tex);
      gl.activeTexture(gl.TEXTURE0);
      return null;
    }

    // Redirect render()'s final composite into our float FBO, then read it back.
    this.outputFbo = fbo;
    try {
      this.render();
    } finally {
      this.outputFbo = null;
    }
    const raw = new Float32Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, raw);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    gl.deleteFramebuffer(fbo);
    gl.activeTexture(gl.TEXTURE7);
    gl.deleteTexture(tex);
    gl.activeTexture(gl.TEXTURE0);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    // glReadPixels rows come back bottom-up; flip to top-down image order.
    const stride = w * 4;
    const data = new Float32Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      data.set(raw.subarray((h - 1 - y) * stride, (h - y) * stride), y * stride);
    }
    return { data, width: w, height: h };
  }

  computeHistogram(extended = false): HistogramData {
    const gl = this.gl;
    const HIST_SIZE = 128;
    const r = new Uint32Array(256);
    const g = new Uint32Array(256);
    const b = new Uint32Array(256);
    const luma = new Uint32Array(256);
    // It redraws what the last render() left bound, so before one there is no
    // frame to measure: the draw would raise a GL error and read back black.
    if (!this.program) return { r, g, b, luma };

    // Allocate the readback targets on the scratch unit, not unit 0. Creating
    // one here binds it to the active unit, and unit 0 is uImage — so the first
    // histogram of a session sampled its own render target (a GL feedback loop,
    // INVALID_OPERATION) and read back an all-black frame. Sampling is driven by
    // the sampler uniforms, so moving the active unit doesn't affect the draws.
    gl.activeTexture(gl.TEXTURE7);

    // Standard histogram: re-render the display output at 128x128 and read it
    // back. We share GL state with the clipping/viz uniforms reset to off so the
    // sampled frame is the plain developed image.
    gl.uniform1i(this.uniforms.uShowClipping, 0);
    gl.uniform1i(this.uniforms.uVizMask, -1);
    gl.uniform1i(this.uniforms.uSharpenViz, 0);

    if (this.haveColorBufferFloat) {
      // Preferred path: render the display-encoded output into an RGBA16F FBO and
      // read it back as float. The values are still display-space in [0,1] (same
      // axis and color space as the 8-bit path, so the tonal zones line up), but
      // continuous rather than quantized to 256 codes. This removes the comb /
      // banding the 8-bit readback shows after any tonal stretch (curves,
      // exposure, per-channel white-balance gains spread the 256 codes apart).
      if (!this.histFboD) {
        this.histTexD = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.histTexD);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, HIST_SIZE, HIST_SIZE, 0, gl.RGBA, gl.HALF_FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.histFboD = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.histFboD);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.histTexD, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.histFboD);
      gl.viewport(0, 0, HIST_SIZE, HIST_SIZE);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      const pxD = new Float32Array(HIST_SIZE * HIST_SIZE * 4);
      gl.readPixels(0, 0, HIST_SIZE, HIST_SIZE, gl.RGBA, gl.FLOAT, pxD);

      for (let i = 0; i < pxD.length; i += 4) {
        // Display output is clamped to [0,1] in the shader; clamp defensively and
        // scale to the 0..255 bin index used by the rest of the histogram code.
        const R = Math.min(255, Math.max(0, pxD[i] * 255));
        const G = Math.min(255, Math.max(0, pxD[i + 1] * 255));
        const B = Math.min(255, Math.max(0, pxD[i + 2] * 255));
        r[R | 0]++; g[G | 0]++; b[B | 0]++;
        luma[(0.2126 * R + 0.7152 * G + 0.0722 * B) | 0]++;
      }
    } else {
      // Fallback when float color buffers aren't renderable: RGBA8 readback.
      // 256 source codes into 256 bins, so a tonal stretch will comb — but this
      // only runs on GPUs without EXT_color_buffer_float.
      if (!this.histFbo) {
        this.histTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.histTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, HIST_SIZE, HIST_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.histFbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.histFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.histTex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.histFbo);
      gl.viewport(0, 0, HIST_SIZE, HIST_SIZE);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      const px8 = new Uint8Array(HIST_SIZE * HIST_SIZE * 4);
      gl.readPixels(0, 0, HIST_SIZE, HIST_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, px8);

      for (let i = 0; i < px8.length; i += 4) {
        const R = px8[i], G = px8[i + 1], B = px8[i + 2];
        r[R]++; g[G]++; b[B]++;
        luma[(0.2126 * R + 0.7152 * G + 0.0722 * B) | 0]++;
      }
    }

    const result: HistogramData = { r, g, b, luma };

    // Extended histogram: unclamped float readback for full-range distribution.
    if (extended && this.haveColorBufferFloat) {
      if (!this.histFboF) {
        this.histTexF = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.histTexF);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, HIST_SIZE, HIST_SIZE, 0, gl.RGBA, gl.HALF_FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.histFboF = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.histFboF);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.histTexF, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }

      gl.uniform1i(this.uniforms.uRawHistogram, 1);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.histFboF);
      gl.viewport(0, 0, HIST_SIZE, HIST_SIZE);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      const pxF = new Float32Array(HIST_SIZE * HIST_SIZE * 4);
      gl.readPixels(0, 0, HIST_SIZE, HIST_SIZE, gl.RGBA, gl.FLOAT, pxF);
      gl.uniform1i(this.uniforms.uRawHistogram, 0);

      const RMIN = -0.25, RMAX = 1.5, BINS = 256;
      const range = RMAX - RMIN;
      const er = new Uint32Array(BINS);
      const eg = new Uint32Array(BINS);
      const eb = new Uint32Array(BINS);
      const el = new Uint32Array(BINS);
      let clipLow = 0, clipHigh = 0;
      const total = HIST_SIZE * HIST_SIZE;
      for (let i = 0; i < pxF.length; i += 4) {
        const R = pxF[i], G = pxF[i + 1], B = pxF[i + 2];
        const L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        if (R <= 0 && G <= 0 && B <= 0) clipLow++;
        if (R >= 1 || G >= 1 || B >= 1) clipHigh++;
        const binR = Math.max(0, Math.min(BINS - 1, ((R - RMIN) / range * BINS) | 0));
        const binG = Math.max(0, Math.min(BINS - 1, ((G - RMIN) / range * BINS) | 0));
        const binB = Math.max(0, Math.min(BINS - 1, ((B - RMIN) / range * BINS) | 0));
        const binL = Math.max(0, Math.min(BINS - 1, ((L - RMIN) / range * BINS) | 0));
        er[binR]++; eg[binG]++; eb[binB]++; el[binL]++;
      }

      result.extended = {
        r: er, g: eg, b: eb, luma: el,
        rangeMin: RMIN, rangeMax: RMAX,
        clipLow: clipLow / total,
        clipHigh: clipHigh / total,
      };
    }

    // Restore main canvas framebuffer, viewport and active texture unit.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.activeTexture(gl.TEXTURE0);
    return result;
  }

  readDownscaledPixels(size: number): { data: Uint8Array; w: number; h: number } | null {
    // Like computeHistogram, it draws with what the last render() left bound.
    if (!this.program || !this.imageWidth || !this.imageHeight) return null;
    const gl = this.gl;

    // Maintain aspect ratio instead of forcing a square
    const aspect = this.imageWidth / this.imageHeight;
    let w: number, h: number;
    if (aspect >= 1) {
      w = size;
      h = Math.max(1, Math.round(size / aspect));
    } else {
      h = size;
      w = Math.max(1, Math.round(size * aspect));
    }

    const fbo = gl.createFramebuffer();
    const tex = gl.createTexture();
    // Use a high texture unit so we don't clobber the image on TEXTURE0
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

    // Temporarily override transform, crop, and viewport to identity so we detect
    // lines across the whole raw frame, not a corrected or zoom-windowed view.
    const u = this.uniforms;
    const IDENTITY_MAT3 = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
    gl.uniform4f(u.uCrop, 0, 0, 1, 1);
    gl.uniform4f(u.uViewport, 0, 0, 1, 1);
    gl.uniformMatrix3fv(u.uInvTransform, false, IDENTITY_MAT3);

    // Re-bind the source image on unit 0 so the shader samples it correctly
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
    gl.uniform1i(u.uShowClipping, 0);
    gl.uniform1i(u.uVizMask, -1);
    gl.uniform1i(u.uSharpenViz, 0);
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    const data = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // glReadPixels returns rows bottom-up; flip so row 0 = top of image,
    // matching the orientation the Hough line detector expects.
    const stride = w * 4;
    for (let top = 0, bot = h - 1; top < bot; top++, bot--) {
      const tOff = top * stride;
      const bOff = bot * stride;
      for (let i = 0; i < stride; i++) {
        const tmp = data[tOff + i];
        data[tOff + i] = data[bOff + i];
        data[bOff + i] = tmp;
      }
    }

    // Restore the real transform, crop, and viewport uniforms
    const vp = this.roi;
    gl.uniform4f(u.uViewport, vp ? vp.x : 0, vp ? vp.y : 0, vp ? vp.w : 1, vp ? vp.h : 1);
    if (this.params) {
      const crop = this.params.crop ?? DEFAULT_CROP;
      gl.uniform4f(u.uCrop, crop.x, crop.y, crop.width, crop.height);
      const imgAspect = this.imageHeight > 0 ? this.imageWidth / this.imageHeight : 1;
      gl.uniformMatrix3fv(
        u.uInvTransform,
        false,
        mat3ColumnMajor(buildInverseTransform(this.params.straighten, this.params.transform, imgAspect)),
      );
    }

    gl.activeTexture(gl.TEXTURE7);
    gl.deleteTexture(tex);
    gl.deleteFramebuffer(fbo);
    gl.activeTexture(gl.TEXTURE0);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    return { data, w, h };
  }

  // ── Multi-pass prepass framework ────────────────────────────────────────

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

  private allocTarget(tex: WebGLTexture, fbo: WebGLFramebuffer, w: number, h: number): boolean {
    const gl = this.gl;
    const internal = this.haveColorBufferFloat ? gl.RGBA16F : gl.RGBA8;
    const type = this.haveColorBufferFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return ok;
  }

  // Lazily (re)allocate the two ping-pong targets. RGBA16F when float render
  // targets are supported, else RGBA8 (denoise still works, clamps HDR). Returns
  // false if a complete framebuffer can't be made (prepasses are then skipped).
  private ensurePingPong(w: number, h: number): boolean {
    const gl = this.gl;
    const internal = this.haveColorBufferFloat ? gl.RGBA16F : gl.RGBA8;
    if (this.ppTex[0] && this.ppW === w && this.ppH === h && this.ppInternalFormat === internal) {
      return true;
    }
    for (let i = 0; i < 2; i++) {
      if (!this.ppTex[i]) this.ppTex[i] = gl.createTexture();
      if (!this.ppFbo[i]) this.ppFbo[i] = gl.createFramebuffer();
      if (!this.allocTarget(this.ppTex[i]!, this.ppFbo[i]!, w, h)) {
        this.ppW = 0;
        this.ppH = 0;
        return false;
      }
    }
    this.ppW = w;
    this.ppH = h;
    this.ppInternalFormat = internal;
    return true;
  }

  private ensureStageResult(stageId: string, w: number, h: number) {
    const gl = this.gl;
    let t = this.stageResultTargets.get(stageId);
    if (!t) {
      t = { tex: gl.createTexture()!, fbo: gl.createFramebuffer()!, w: 0, h: 0 };
      this.stageResultTargets.set(stageId, t);
    }
    if (t.w !== w || t.h !== h) {
      this.allocTarget(t.tex, t.fbo, w, h);
      t.w = w;
      t.h = h;
    }
    return t;
  }

  private getPassProgram(key: string, fragmentSource: string, bindings: ContributedBinding[]) {
    let e = this.passPrograms.get(key);
    if (e) return e;
    const program = this.createProgram(PASS_VERTEX_SHADER, fragmentSource);
    const gl = this.gl;
    const locs: Record<string, WebGLUniformLocation | null> = {};
    for (const n of [
      "uPrevPass", "uTexel", "uPassIndex", "uPassCount",
      "uPrevRaw", "uSrcLinear", "uIsFallbackPreview", "uApplyBaseCurve",
    ]) {
      locs[n] = gl.getUniformLocation(program, n);
    }
    for (const b of bindings) locs[b.glslName] = gl.getUniformLocation(program, b.glslName);
    e = { program, locs };
    this.passPrograms.set(key, e);
    return e;
  }

  // True when the param bag holds a non-trivial value for any of this stage's
  // keys, i.e. the stage actually does something this frame. Lets an untouched
  // denoise stage cost nothing (its inline glsl early-outs anyway). Booleans and
  // vectors count alongside numbers: a bool/vector-driven prepass used to be seen
  // as inactive (only non-zero numbers qualified), so such stages never ran.
  private prepassActive(stageId: string): boolean {
    const prefix = stageId + ".";
    for (const [k, v] of Object.entries(this.contributedParams)) {
      if (!k.startsWith(prefix)) continue;
      if (paramIsActive(v)) return true;
    }
    return false;
  }

  // Signature of everything a stage's prepass RESULT depends on: the source
  // (srcSig), pass-resolution, linearization flags, and this stage's PASS param
  // values (inline blend params don't affect the prepass, so they're excluded —
  // that's what makes dragging Luminance Amount, exposure, etc. a cache hit).
  private prepassSig(stage: PrepassStage, srcSig: string, w: number, h: number, baseCurve: number): string {
    let params = "";
    for (const pass of stage.passes) {
      for (const b of pass.bindings) {
        params += `${b.qualifiedKey}=${String(this.contributedParams[b.qualifiedKey] ?? b.default)};`;
      }
    }
    return `${srcSig}|${w}x${h}|${this.linear ? 1 : 0}${this.isFallbackPreview ? 1 : 0}${baseCurve}|${params}`;
  }

  // Run every prepass stage against `srcTex` (the develop source — patched when
  // retouch is active). `srcSig` identifies the source contents for caching.
  // `applyRetouch`: whether a split draw must apply the retouch itself, as the
  // main draw does when there is no patched source. `params` are the frame's,
  // read for a split draw's cache key. Leaves results in per-stage targets and
  // records the unit bindings the main draw applies via bindPrepassResults().
  private runPrepasses(
    srcTex: WebGLTexture,
    srcSig: string,
    applyRetouch: boolean,
    params: DevelopParams,
  ) {
    this.prepassResults = [];
    this.denoiseReady = false; // set true below only if the denoise prepass yields a real result
    if (this.prepassStages.length === 0) return;
    const gl = this.gl;
    const { w, h } = this.prepassDims();
    const haveTargets = this.ensurePingPong(w, h);
    const baseCurve = this.applyBaseCurve && !this.pipelineSkipBase ? 1 : 0;

    // The units are a hard budget, so they go to the stages that actually
    // produce a result this frame; every inactive/failed stage shares one slot
    // holding the raw source. EVERY stage gets an explicit binding — a sampler
    // that is never uniform1i'd defaults to unit 0 and silently reads uImage,
    // which is exactly the garbage an active-but-starved stage must never see
    // (SafeLight #96: the Contrast Equalizer's coarsest band decoded the raw
    // image as wavelet detail and crushed the render to black).
    const active = this.prepassStages.map(
      (s) => haveTargets && !this.failedPrepass.has(s.stageId) && this.prepassActive(s.stageId),
    );
    const unitOf = new Map<number, number>();
    let next = 0;
    for (let i = 0; i < this.prepassStages.length; i++) {
      if (active[i] && next < PREPASS_UNITS.length) unitOf.set(i, PREPASS_UNITS[next++]);
    }
    const spareUnit = next < PREPASS_UNITS.length ? PREPASS_UNITS[next] : -1;

    for (let i = 0; i < this.prepassStages.length; i++) {
      const stage = this.prepassStages[i];
      const unit = unitOf.get(i);
      if (unit === undefined) {
        if (active[i] && !this.warnedPrepassOverflow.has(stage.stageId)) {
          this.warnedPrepassOverflow.add(stage.stageId);
          console.warn(
            `[render] prepass stage '${stage.stageId}' exceeds the ${MAX_PREPASS_STAGES}-slot ` +
              `budget and will not run; its inline reads another stage's result.`,
          );
        }
        continue; // resolved after the loop, once the winners' textures are known
      }

      // Cache hit: nothing the prepass depends on changed — reuse the result and
      // skip the passes entirely.
      const split = stage.split && this.splitDrawable(stage.stageId) ? stage.split : null;
      const stageSrcSig = split
        ? `${srcSig}|split:${this.splitToken(stage.stageId, split, params)}`
        : srcSig;
      const sig = this.prepassSig(stage, stageSrcSig, w, h, baseCurve);
      const cached = this.stageResultTargets.get(stage.stageId);
      if (cached && cached.w === w && cached.h === h && this.prepassSigs.get(stage.stageId) === sig) {
        this.prepassResults.push({ resultUniform: stage.resultUniform, tex: cached.tex, unit });
        if (stage.stageId === BUILTIN_DENOISE_ID) this.denoiseReady = true;
        continue;
      }

      // A throwing pass (e.g. a shader that fails to compile) must not crash the
      // whole render. Disable just this stage for the session and fall back to
      // the raw source so the rest of the pipeline keeps working.
      try {
        let readTex: WebGLTexture = srcTex;
        let prevRaw = true;            // first read linearizes + base-curves the source
        let writeIdx = 0;
        let lastIdx = 0;
        if (split) {
          this.drawSplit(split.index, srcTex, applyRetouch, w, h);
          readTex = this.ppTex[0]!;
          prevRaw = false;
          writeIdx = 1;
        }
        let passIdx = 0;
        for (const pass of stage.passes) {
          // Distinguish passes by index AND source hash: two passes of one stage
          // with equal-length sources (separable H/V blur) share a length, so a
          // length-only key collided and reused the first pass's program.
          const key = `${this.stageSig}|${stage.stageId}|${passIdx}|${simpleHash(pass.fragmentSource)}`;
          passIdx++;
          const prog = this.getPassProgram(key, pass.fragmentSource, pass.bindings);
          for (let it = 0; it < pass.iterations; it++) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.ppFbo[writeIdx]);
            gl.viewport(0, 0, w, h);
            gl.useProgram(prog.program);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, readTex);
            gl.uniform1i(prog.locs.uPrevPass!, 0);
            gl.uniform2f(prog.locs.uTexel!, 1 / w, 1 / h);
            gl.uniform1i(prog.locs.uPassIndex!, it);
            gl.uniform1i(prog.locs.uPassCount!, pass.iterations);
            gl.uniform1i(prog.locs.uPrevRaw!, prevRaw ? 1 : 0);
            gl.uniform1i(prog.locs.uSrcLinear!, this.linear ? 1 : 0);
            gl.uniform1i(prog.locs.uIsFallbackPreview!, this.isFallbackPreview ? 1 : 0);
            gl.uniform1i(prog.locs.uApplyBaseCurve!, baseCurve);
            for (const b of pass.bindings) {
              const loc = prog.locs[b.glslName];
              if (loc == null) continue;
              bindUniformByType(gl, loc, b.glslType, this.contributedParams[b.qualifiedKey] ?? b.default);
            }
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            this.draws.pass++;
            readTex = this.ppTex[writeIdx]!;
            prevRaw = false;
            lastIdx = writeIdx;
            writeIdx = 1 - writeIdx;
          }
        }

        // Copy the final ping-pong result into the stage's dedicated target so the
        // next stage's ping-pong doesn't clobber it.
        const target = this.ensureStageResult(stage.stageId, w, h);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.ppFbo[lastIdx]);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.fbo);
        gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
        this.prepassSigs.set(stage.stageId, sig);
        this.prepassResults.push({ resultUniform: stage.resultUniform, tex: target.tex, unit });
        if (stage.stageId === BUILTIN_DENOISE_ID) this.denoiseReady = true;
      } catch (err) {
        console.error(`[render] prepass stage '${stage.stageId}' failed; disabling it`, err);
        this.failedPrepass.add(stage.stageId);
        this.prepassResults.push({ resultUniform: stage.resultUniform, tex: srcTex, unit });
      }
    }

    // Stages that got no unit: inactive/failed ones share the spare slot with
    // the raw source bound (their inline gates itself off, so the value is
    // never used). When every slot went to an active stage there is no spare,
    // so the rest alias the first winner's binding — a complete texture with
    // bounded values, never the unit-0 image.
    const fallback =
      spareUnit >= 0
        ? { tex: srcTex, unit: spareUnit }
        : this.prepassResults.length > 0
          ? { tex: this.prepassResults[0].tex, unit: this.prepassResults[0].unit }
          : null;
    if (fallback) {
      for (let i = 0; i < this.prepassStages.length; i++) {
        if (!unitOf.has(i)) {
          this.prepassResults.push({
            resultUniform: this.prepassStages[i].resultUniform,
            tex: fallback.tex,
            unit: fallback.unit,
          });
        }
      }
    }
  }

  // Bind each prepass result onto the (already active) main program.
  private bindPrepassResults() {
    const gl = this.gl;
    for (const r of this.prepassResults) {
      const loc = this.uniforms[r.resultUniform];
      if (loc == null) continue;
      gl.activeTexture(gl.TEXTURE0 + r.unit);
      gl.bindTexture(gl.TEXTURE_2D, r.tex);
      gl.uniform1i(loc, r.unit);
    }
    // Tell the main shader whether the built-in denoise result is real this frame
    // (set during runPrepasses) so its inline only swaps `lin` when it's valid.
    const okLoc = this.uniforms.uDenoiseReady;
    if (okLoc != null) gl.uniform1i(okLoc, this.denoiseReady ? 1 : 0);
  }

  // A split stores signed, unbounded values; an RGBA8 target would clip
  // exactly what reading the current image is for.
  private splitDrawable(stageId: string): boolean {
    if (this.haveColorBufferFloat) return true;
    if (!this.warnedSplitFallback.has(stageId)) {
      this.warnedSplitFallback.add(stageId);
      console.warn(
        `[render] stage '${stageId}' reads the current image, but this GPU has no float ` +
          `render targets; it reads the source instead.`,
      );
    }
    return false;
  }

  // Texture versions are read every frame: the export renderer shares the
  // main thread's stage-texture record, which is updated in place.
  private splitToken(stageId: string, split: StageSplit, params: DevelopParams): number {
    const textureVersions: Record<string, number> = {};
    for (const [qk, data] of Object.entries(this.stageTextures)) textureVersions[qk] = data.version;
    return this.splitTokens.token(stageId, split, {
      params,
      bag: this.contributedParams,
      textureVersions,
      context: [
        this.pipelineSig,
        variantKey(this.variant),
        this.hslRange,
        this.hslSmooth,
        this.asShotTemperature,
        this.hasContribNR,
      ].join("|"),
    });
  }

  // Draw the develop program up to one stage's input into ppTex[0], in source
  // texels at prepass size, for that stage's first pass to read. Only results
  // already produced this frame are bound, and ppTex[0] is never bound as a
  // sampler: unit 0 holds the source when the draw runs. uSplitAt is set on
  // the main program around this one draw, so no other draw sees it.
  private drawSplit(
    index: number,
    srcTex: WebGLTexture,
    applyRetouch: boolean,
    w: number,
    h: number,
  ): void {
    const gl = this.gl;
    gl.useProgram(this.developProgram());
    gl.uniform1i(this.uniforms.uSplitAt, index);
    this.drawDevelop(srcTex, applyRetouch, { fbo: this.ppFbo[0], w, h });
    gl.uniform1i(this.uniforms.uSplitAt, -1);
    this.draws.split++;
  }

  // Pass 1 of a retouched frame: bake the retouch into the offscreen copy of the
  // source, then build its mip chain so the develop's blur taps read the
  // patched pixels. Returns false when no patched copy could be made, so the
  // caller falls back to the in-shader retouch.
  private bakePatchedSource(): boolean {
    const gl = this.gl;
    const u = this.uniforms;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.developedFbo);
    gl.viewport(0, 0, this.devW, this.devH);
    // Break a feedback loop: bindPrepassResults (end of the previous frame) may
    // leave developedTex bound to a prepass-result sampler unit. Rendering INTO
    // developedTex here while it's still bound as a sampler input on the active
    // program is a GL feedback loop (undefined — drivers can drop the write,
    // leaving the patched source stale, so heal edits never appear when a stage
    // with an active prepass result is registered). Detach those units first.
    for (const pu of PREPASS_UNITS) {
      gl.activeTexture(gl.TEXTURE0 + pu);
      gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture); // read the original source
    gl.uniform1i(u.uImage, 0);
    gl.uniform1i(u.uPatchPass, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindTexture(gl.TEXTURE_2D, this.developedTex);
    // getError stalls the pipeline, so it runs only for the first mipmap after
    // each 16-bit (re)allocation rather than on every retouched frame.
    const verify = this.developedFormat !== "rgba8" && !this.developedMipsVerified;
    if (verify) while (gl.getError() !== gl.NO_ERROR) {} // clear prior errors
    gl.generateMipmap(gl.TEXTURE_2D);
    if (!verify) return true;
    if (gl.getError() === gl.NO_ERROR) {
      this.developedMipsVerified = true;
      return true;
    }
    // The 2x2 constructor probe passed (norm16), or float colour buffers made
    // RGBA16F renderable, but this driver fails generateMipmap on the full-size
    // target (0x0502). An incomplete mip chain samples as black, so abandon that
    // format for this renderer and re-bake this frame's copy into the next one
    // down.
    while (gl.getError() !== gl.NO_ERROR) {}
    if (this.developedFormat === "float16") this.haveFloat16Developed = false;
    else this.haveNorm16 = false;
    return this.prepareDevelopedTarget() && this.bakePatchedSource();
  }

  // Create / resize the offscreen develop target (capped source size). Returns
  // false if the framebuffer can't be completed, so the caller falls back.
  private prepareDevelopedTarget(): boolean {
    if (!this.imageWidth || !this.imageHeight) return false;
    const longEdge = Math.max(this.imageWidth, this.imageHeight);
    const scale = longEdge > 0 ? Math.min(1, this.maxEdge / longEdge) : 1;
    const w = Math.max(1, Math.round(this.imageWidth * scale));
    const h = Math.max(1, Math.round(this.imageHeight * scale));
    const gl = this.gl;
    if (!this.developedTex) {
      this.developedTex = gl.createTexture();
      this.developedFbo = gl.createFramebuffer();
    }
    // An RGBA8 patched-source copy quantises a 16-bit/float linear source to 8 bits,
    // so any heal spot bands smooth gradients. RGBA16 (norm16) is colour-renderable,
    // filterable AND GPU-mipmappable, so it removes the banding while keeping the
    // per-frame generateMipmap and the same linear/[0,1] semantics. RGBA16F is all
    // three once float colour buffers are renderable, and it also keeps the headroom
    // and the channels below black: the copy a version 2 photo develops from.
    // Version 1 photos keep the clipped copy their edits were made with.
    const wanted: DevelopedFormat =
      this.variant.fullInfo && this.haveFloat16Developed ? "float16"
      : this.haveNorm16 ? "norm16"
      : "rgba8";
    if (this.devW !== w || this.devH !== h || this.developedFormat !== wanted) {
      // Try the wanted format first; if its target isn't framebuffer-complete on
      // this device, step down to norm16, then RGBA8, rather than fail.
      const alloc = (format: DevelopedFormat): boolean => {
        // On the scratch unit, and let go of afterwards: the unit active here can
        // be one a sampler reads (render() leaves 4 active), and a unit holding the
        // copy while the patch pass draws into it is a feedback loop for any
        // sampler that reads that unit.
        gl.activeTexture(gl.TEXTURE7);
        gl.bindTexture(gl.TEXTURE_2D, this.developedTex);
        if (format === "float16") {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
        } else if (format === "norm16") {
          gl.texImage2D(gl.TEXTURE_2D, 0, this.norm16Format, w, h, 0, gl.RGBA, gl.UNSIGNED_SHORT, null);
        } else {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        }
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.developedFbo);
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.developedTex, 0,
        );
        const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
        return complete;
      };
      const formats: DevelopedFormat[] = [wanted];
      if (wanted === "float16" && this.haveNorm16) formats.push("norm16");
      if (wanted !== "rgba8") formats.push("rgba8");
      let format: DevelopedFormat | null = null;
      for (const candidate of formats) {
        if (alloc(candidate)) {
          format = candidate;
          break;
        }
      }
      if (!format) {
        this.devW = 0;
        this.devH = 0;
        return false;
      }
      this.developedFormat = format;
      this.developedMipsVerified = false;
      this.devW = w;
      this.devH = h;
    }
    return true;
  }

  dispose() {
    const gl = this.gl;
    // Free every resident source, plus the active image texture if the renderer
    // still owns it (a cache-owned active texture is freed by the loop above).
    for (const e of this.sourceCache.values()) gl.deleteTexture(e.tex);
    this.sourceCache.clear();
    if (this.imageTextureOwned) gl.deleteTexture(this.imageTexture);
    gl.deleteTexture(this.curveTexture);
    gl.deleteTexture(this.maskCurveTexture);
    if (this.developedTex) gl.deleteTexture(this.developedTex);
    if (this.developedFbo) gl.deleteFramebuffer(this.developedFbo);
    gl.deleteTexture(this.maskTexture);
    gl.deleteTexture(this.retouchTexture);
    // Histogram readback targets (8-bit, float, display-float), all lazily created.
    for (const t of [this.histTex, this.histTexF, this.histTexD]) if (t) gl.deleteTexture(t);
    for (const f of [this.histFbo, this.histFboF, this.histFboD]) if (f) gl.deleteFramebuffer(f);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.quadBuf) gl.deleteBuffer(this.quadBuf);
    // Prepass framework: ping-pong targets, per-stage results, pass programs.
    for (const t of this.ppTex) if (t) gl.deleteTexture(t);
    for (const f of this.ppFbo) if (f) gl.deleteFramebuffer(f);
    for (const t of this.stageResultTargets.values()) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    }
    this.stageResultTargets.clear();
    // Extension stage textures (LUT atlases) + the shared dummy.
    for (const e of this.uploadedStageTex.values()) gl.deleteTexture(e.tex);
    this.uploadedStageTex.clear();
    if (this.dummyStageTex) gl.deleteTexture(this.dummyStageTex);
    for (const e of this.passPrograms.values()) gl.deleteProgram(e.program);
    this.passPrograms.clear();
    // Fallback entries can share a program under several sigs — dedupe.
    // The active program is always one of the cache's entries, so the cache covers it.
    const programs = new Set<WebGLProgram>();
    for (const e of this.programCache.values()) programs.add(e.program);
    for (const prog of programs) gl.deleteProgram(prog);
  }
}
