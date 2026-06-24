// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { DevelopParams, Mask, MaskAdjustments, RetouchSpot } from "@/catalog/types";
import {
  DEFAULT_CROP,
  HSL_CHANNELS,
  MAX_MASKS,
  MAX_MASK_COMPONENTS,
  MAX_RETOUCH,
  MAX_RETOUCH_BRUSH,
  isDefaultHSL,
  isDefaultToneCurves,
} from "@/catalog/types";
import type { HistogramData } from "../histogram";
import { buildMaskCurveLUT, buildRGBCurveLUT } from "../curve";
import { buildInverseTransform, mat3ColumnMajor } from "../transform";
import { buildFragmentShader, VERTEX_SHADER, type StageInjection } from "./shaders";
import {
  uniformPrefix,
  helperPrefix,
  extractHelperNames,
  emitUniformDecl,
  rewriteGlsl,
  simpleHash,
} from "./shader-compiler";
import { computeAutoCropScale } from "@/lens-profiles/auto-crop";
import { useRegistry } from "@/extensions/registry";
import {
  PROCESSING_PHASE_ORDER,
  type GlslType,
  type ProcessingPhase,
  type ProcessingStageContribution,
  type StagePass,
  type StageTextureData,
} from "@/extensions/types";
import {
  OUT_SPACE_CODE,
  outMatrixColumnMajor,
  type ColorSpaceId,
} from "../color-space";
import {
  BUILTIN_RESOLVED,
  resolveActivePipeline,
  type ResolvedPipeline,
} from "@/extensions/pipelines";

// Fixed attribute locations (bound before link), so every pipeline variant of
// the program shares the one VAO — swapping pipelines never rebuilds geometry.
const ATTR_POS = 0;
const ATTR_UV = 1;

// Prepass result samplers bind to texture units >= this; units 0-7 are taken by
// the develop shader (image, curve, masks, retouch, developed, heal, …).
const PREPASS_UNIT_BASE = 8;
const MAX_PREPASS_STAGES = 4;

// Extension stage textures (baked LUT atlases, etc.) bind to units above the
// prepass range. WebGL2 guarantees >= 16 fragment texture units, so 12-15 are
// always available.
const STAGE_TEX_UNIT_BASE = PREPASS_UNIT_BASE + MAX_PREPASS_STAGES; // 12
const MAX_STAGE_TEXTURES = 4;

// One compiled develop program per pipeline signature: switching transforms
// (or back) is an O(1) swap with no shader recompile or uniform re-query.
interface PipelineProgram {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
  skipBase: boolean;
}
import { bakeCoverage, coverageSignature, type CoverageItem } from "./mask-coverage";
import { contentAwareFill } from "../content-aware-fill";
import { setHealSourceImage } from "../heal-source";
import { getSettings } from "@/state/settings-store";

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
  bytes: number;
  lastUsed: number;
}

// Working resolution for the CPU heal-source search (and the disabled
// content-aware fill). Big enough that thin structures (edges, lines) survive
// the downscale so the source picker can match and continue them; the search
// cost is independent of this, only the sampling fidelity changes.
const FILL_EDGE = 384;

// Experimental CPU content-aware heal fill. Off: heal copies the source verbatim
// (predictable, artifact-free). Flip to re-enable the PatchMatch synthesis path.
let CONTENT_AWARE_HEAL = false;

// Gradient-domain (membrane) heal: heal spots blend their copied texture into the
// surroundings with a per-pixel low-frequency correction instead of one flat mean
// offset, so the seam vanishes across tone gradients. Flip to false to A/B against
// the old flat-tint path (clone is unaffected either way).
const MEMBRANE_HEAL = true;

// sRGB(16-bit code value) -> linear, built once. Fallback for the rare GPU
// without EXT_texture_norm16, where the cached 16-bit preview can't be uploaded
// as a normalized texture and must be linearised on the CPU. A 65536-entry LUT
// turns the per-sample pow() into a table read.
let SRGB16_TO_LINEAR: Float32Array | null = null;
function srgb16ToLinearLut(): Float32Array {
  if (SRGB16_TO_LINEAR) return SRGB16_TO_LINEAR;
  const lut = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) {
    const e = i / 65535;
    lut[i] = e <= 0.04045 ? e / 12.92 : Math.pow((e + 0.055) / 1.055, 2.4);
  }
  SRGB16_TO_LINEAR = lut;
  return lut;
}

// Expand a raw 16-bit sRGB RGBA buffer to a linear Float32 image (CPU fallback
// path; the GPU normally does this decode while sampling the norm16 texture).
// Return type matches the float-image member so it unifies with the live float
// decode in setImage (isFallbackPreview stays absent — a cache is never a fallback).
function srgb16ToFloatImage(
  img: { data: Uint16Array; width: number; height: number },
): { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean } {
  const lut = srgb16ToLinearLut();
  const src = img.data;
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = lut[src[i]];
  return { kind: "float", data: out, width: img.width, height: img.height };
}

function downsampleRGBA(src: Uint8ClampedArray | Uint8Array, W: number, H: number) {
  const scale = Math.min(1, FILL_EDGE / Math.max(W, H));
  const w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor((y * H) / h);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * H) / h));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x * W) / w);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * W) / w));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const si = (sy * W + sx) * 4;
          r += src[si]; g += src[si + 1]; b += src[si + 2]; n++;
        }
      }
      const di = (y * w + x) * 4;
      out[di] = r / n; out[di + 1] = g / n; out[di + 2] = b / n; out[di + 3] = 255;
    }
  }
  return { data: out, w, h };
}

// Box-halve an RGBA Float32 image (linear space). Used to build a float mip chain
// by hand: WebGL2 cannot generateMipmap on RGBA16F, but it can sample manually
// supplied float mip levels with trilinear filtering, which the local-contrast
// taps (Texture/Clarity/Dehaze/Sharpen) need. Working in 16-bit float keeps real
// precision and HDR headroom so a big exposure push doesn't posterise into bands.
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

// Rasterise a retouch disc (radius in image-height units) into the hole mask.
function stampDisc(
  hole: Uint8Array, W: number, H: number, aspect: number,
  cx: number, cy: number, r: number,
) {
  const rax = r / aspect;
  const x0 = Math.max(0, Math.floor((cx - rax) * W));
  const x1 = Math.min(W - 1, Math.ceil((cx + rax) * W));
  const y0 = Math.max(0, Math.floor((cy - r) * H));
  const y1 = Math.min(H - 1, Math.ceil((cy + r) * H));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x / W - cx) * aspect;
      const dy = y / H - cy;
      if (dx * dx + dy * dy <= r * r) hole[y * W + x] = 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Stage injection: collect active processing stages from the registry and
// build the GLSL strings that buildFragmentShader splices into the monolith.
// ---------------------------------------------------------------------------

const phaseIndex = new Map(PROCESSING_PHASE_ORDER.map((p, i) => [p, i]));

function stageSort(a: ProcessingStageContribution, b: ProcessingStageContribution): number {
  const pi = (phaseIndex.get(a.phase) ?? 99) - (phaseIndex.get(b.phase) ?? 99);
  if (pi !== 0) return pi;
  return (a.priority ?? 100) - (b.priority ?? 100);
}

/** A single extension-contributed uniform, resolved to its namespaced GLSL name
 *  so render() can bind its value generically from the contributed param bag. */
interface ContributedBinding {
  /** Qualified key "{stageId}.{key}" — the param-bag key and uniform-cache key. */
  qualifiedKey: string;
  /** Namespaced GLSL identifier, e.g. "u_ab12_lumaAmount". */
  glslName: string;
  glslType: GlslType;
  default: number | number[] | boolean;
}

/** A stage-declared texture (e.g. a LUT atlas), resolved to its namespaced
 *  sampler so render() can bind its uploaded data each frame. */
interface StageTextureBinding {
  /** Qualified key "{stageId}.{key}" — also the stage-texture bag key. */
  qualifiedKey: string;
  /** Namespaced sampler identifier, e.g. "u_ab12_lut". */
  glslName: string;
}

/** Which injection group a phase maps to. Linear-space phases operate on `lin`
 *  (the scene-linear working color); display-space phases operate on `c`. */
function phaseGroup(
  phase: ProcessingPhase,
): "srcUv" | "noiseReduction" | "sceneLinear" | "effects" {
  switch (phase) {
    case "geometry":
      return "srcUv";
    case "decode":
    case "noise-reduction":
      return "noiseReduction";
    case "scene-linear":
    case "tone-map":
      return "sceneLinear";
    default: // display-adjust, effects, output-encode
      return "effects";
  }
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

// ---------------------------------------------------------------------------
// Multi-pass prepass framework
// ---------------------------------------------------------------------------

// Passes render a plain fullscreen quad in SOURCE-UV space — no V flip — so that
// stageResult sampled at srcUv in the main shader aligns with uImage[srcUv].
const PASS_VERTEX_SHADER = `#version 300 es
in vec2 aPos;
in vec2 aUv;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

// Reproduce the main shader's pre-NR transform (linearize + RAW base curve) so a
// prepass result lives in the same tonal space as `lin` at the NR marker — then
// the stage's inline glsl can blend stageResult into lin without a tone shift.
const PASS_SHARED_GLSL = `
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 linearToSrgbU(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
uniform sampler2D uPrevPass;
uniform vec2 uTexel;
uniform int uPassIndex;
uniform int uPassCount;
uniform bool uPrevRaw;            // true only for the first read of the source
uniform bool uSrcLinear;
uniform bool uIsFallbackPreview;
uniform bool uApplyBaseCurve;
vec3 toLin(vec3 src) {
  vec3 lin = uSrcLinear ? src : (uIsFallbackPreview ? src : srgbToLinear(src));
  if (uApplyBaseCurve) {
    vec3 d  = linearToSrgbU(lin);
    vec3 dc = clamp(d, 0.0, 1.0);
    vec3 s  = dc * dc * (3.0 - 2.0 * dc);
    vec3 cc = mix(dc, s, 0.55) + max(d - 1.0, 0.0);
    lin = srgbToLinear(cc);
  }
  return lin;
}
vec3 readPrev(vec2 uv) {
  vec3 s = texture(uPrevPass, uv).rgb;
  return uPrevRaw ? toLin(s) : s;
}
`;

interface PrepassPass {
  fragmentSource: string;
  iterations: number;
  bindings: ContributedBinding[];
}

interface PrepassStage {
  stageId: string;
  /** Sampler name the main shader reads stageResult from. */
  resultUniform: string;
  passes: PrepassPass[];
}

/** Build a complete fragment program for one StagePass, namespacing its uniforms
 *  + helpers under the owning stage's prefix so they share the stage's param keys. */
function buildPassFragment(
  stageId: string,
  pass: StagePass,
): { fragmentSource: string; bindings: ContributedBinding[] } {
  const uPfx = uniformPrefix(stageId);
  const hPfx = helperPrefix(stageId);
  const uniforms = pass.uniforms ?? [];
  const bindings: ContributedBinding[] = uniforms.map((u) => ({
    qualifiedKey: `${stageId}.${u.key}`,
    glslName: uPfx + u.key,
    glslType: u.glslType,
    default: u.default,
  }));
  const uniformDecls = uniforms.map((u) => emitUniformDecl(u, uPfx)).join("\n");
  const helperNames = pass.helpers ? extractHelperNames(pass.helpers) : [];
  let helpers = "";
  if (pass.helpers) {
    let h = pass.helpers;
    for (const n of helperNames) h = h.replaceAll(n, hPfx + n);
    for (const u of uniforms) h = h.replaceAll(u.key, uPfx + u.key);
    helpers = h;
  }
  const body = rewriteGlsl(pass.glsl, uniforms, uPfx, hPfx, helperNames);
  const fragmentSource = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
${uniformDecls}
${PASS_SHARED_GLSL}
${helpers}
void main() {
  vec3 c = readPrev(vUv);
  {
${body}
  }
  fragColor = vec4(c, 1.0);
}
`;
  return { fragmentSource, bindings };
}

function buildStageInjection(
  injected?: ProcessingStageContribution[],
): {
  injection: StageInjection;
  sig: string;
  bindings: ContributedBinding[];
  textureBindings: StageTextureBinding[];
  prepass: PrepassStage[];
  hasNoiseReduction: boolean;
} {
  const stages = (
    injected ?? Object.values(useRegistry.getState().processingStages)
  )
    .slice()
    .sort(stageSort);

  const uniformDecls: string[] = [];
  const helperBlocks: string[] = [];
  const groups = { srcUv: [] as string[], noiseReduction: [] as string[], sceneLinear: [] as string[], effects: [] as string[] };
  const bindings: ContributedBinding[] = [];
  const textureBindings: StageTextureBinding[] = [];
  const prepass: PrepassStage[] = [];
  const sigParts: string[] = [];
  let hasNoiseReduction = false;

  for (const s of stages) {
    const group = phaseGroup(s.phase);
    if (!s.id.startsWith("core.") && s.phase === "noise-reduction") hasNoiseReduction = true;
    // Core stages (vignette/grain) keep raw uniform names: their values are
    // bound by hand in render() from typed DevelopParams, not the param bag.
    if (s.id.startsWith("core.")) {
      for (const u of s.uniforms) uniformDecls.push(`uniform ${u.glslType} ${u.key};`);
      if (s.helpers) helperBlocks.push(s.helpers);
      groups[group].push(`{\n${s.glsl}\n}`);
      sigParts.push(s.id);
      continue;
    }

    // Extension stages: namespace uniforms + helpers so two extensions never
    // collide, and record bindings so render() can drive them from the bag.
    const uPfx = uniformPrefix(s.id);
    const hPfx = helperPrefix(s.id);
    for (const u of s.uniforms) {
      uniformDecls.push(emitUniformDecl(u, uPfx));
      bindings.push({
        qualifiedKey: `${s.id}.${u.key}`,
        glslName: uPfx + u.key,
        glslType: u.glslType,
        default: u.default,
      });
    }
    // Stage textures (e.g. baked LUT atlases): emit one namespaced sampler per
    // declared texture, exposed to the inline glsl / helpers under its `key`,
    // and recorded so render() can bind the uploaded data. Part of the sig so a
    // change in the texture set recompiles, but a data swap (same set) doesn't.
    for (const t of s.textures ?? []) {
      const glslName = uPfx + t.key;
      uniformDecls.push(`uniform sampler2D ${glslName};`);
      textureBindings.push({ qualifiedKey: `${s.id}.${t.key}`, glslName });
      sigParts.push(`${s.id}~tex:${t.key}`);
    }

    let helperNames: string[] = [];
    if (s.helpers) {
      helperNames = extractHelperNames(s.helpers);
      let h = s.helpers;
      for (const n of helperNames) h = h.replaceAll(n, hPfx + n);
      for (const u of s.uniforms) h = h.replaceAll(u.key, uPfx + u.key);
      for (const t of s.textures ?? []) h = h.replaceAll(t.key, uPfx + t.key);
      helperBlocks.push(h);
    }

    // Prepass-bearing stages: expose the prepass result to the inline glsl as
    // `vec3 stageResult` and compile a program per pass. Pass uniforms join the
    // same namespace so one param key can drive both the pass and the inline glsl.
    let prelude = "";
    if (s.passes && s.passes.length > 0) {
      const resultUniform = `${uPfx}stageResult`;
      uniformDecls.push(`uniform sampler2D ${resultUniform};`);
      prelude = `vec3 stageResult = texture(${resultUniform}, srcUv).rgb;\n`;
      const passes: PrepassPass[] = s.passes.map((p) => {
        const built = buildPassFragment(s.id, p);
        for (const b of built.bindings) {
          if (!bindings.some((x) => x.qualifiedKey === b.qualifiedKey)) bindings.push(b);
        }
        return {
          fragmentSource: built.fragmentSource,
          iterations: Math.max(1, p.iterations ?? 1),
          bindings: built.bindings,
        };
      });
      prepass.push({ stageId: s.id, resultUniform, passes });
      sigParts.push(
        `${s.id}#${s.passes.map((p) => simpleHash(p.glsl)).join(",")}`,
      );
    }

    let inline = rewriteGlsl(s.glsl, s.uniforms, uPfx, hPfx, helperNames);
    for (const t of s.textures ?? []) inline = inline.replaceAll(t.key, uPfx + t.key);
    groups[group].push(`{\n${prelude}${inline}\n}`);
    sigParts.push(`${s.id}:${simpleHash(s.glsl)}`);
  }

  return {
    injection: {
      uniforms: uniformDecls.join("\n"),
      helpers: helperBlocks.join("\n\n"),
      srcUv: groups.srcUv.join("\n  "),
      noiseReduction: groups.noiseReduction.join("\n  "),
      sceneLinear: groups.sceneLinear.join("\n  "),
      effects: groups.effects.join("\n  "),
    },
    sig: sigParts.join("|"),
    bindings,
    textureBindings,
    prepass,
    hasNoiseReduction,
  };
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
  private program: WebGLProgram;
  private imageTexture: WebGLTexture;
  private curveTexture: WebGLTexture;
  // Per-mask tone-curve LUT atlas (256 x MAX_MASKS RGBA; one row per mask).
  private maskCurveTexture: WebGLTexture;
  private maskCurveAtlas = new Uint8Array(256 * MAX_MASKS * 4);
  private maskTexture: WebGLTexture;
  private maskSig = "";
  private maskChannelOf: Record<string, number> = {};
  private retouchTexture: WebGLTexture;
  private retouchSig = "";
  private retouchChannelOf: Record<string, number> = {};
  // Offscreen "develop without retouch" target, sampled so heal matches tone in
  // edited space. Sized to the (capped) source; lazily created on first heal.
  private developedTex: WebGLTexture | null = null;
  private developedFbo: WebGLFramebuffer | null = null;
  private devW = 0;
  private devH = 0;
  // Content-aware heal fill, computed on the CPU from the (pre-edit) source.
  private healFillTex: WebGLTexture | null = null;
  private haveHealFill = false;
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
  // (source, this stage's pass params, dims, linearization) changed — so editing
  // unrelated controls (exposure, etc.) doesn't recompute denoise.
  private prepassSigs = new Map<string, string>();
  // Bumped whenever the active source texture is swapped (setImage / bindSource).
  private sourceEpoch = 0;
  private params: DevelopParams | null = null;
  private lensProfile: import("@/lens-profiles/types").ResolvedProfile | null = null;
  private autoCropScale = 1;
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
  private maxEdge = MAX_EDGE;
  // Output color space. Live develop/loupe/thumbnails stay sRGB (a no-op in the
  // shader); export sets a wider space so the encode + ICC match.
  private outSpace: ColorSpaceId = "srgb";
  private linear = false;
  private isFallbackPreview = false;
  private applyBaseCurve = false;
  // EXT_texture_norm16: lets the cached 16-bit sRGB preview upload as a normalized,
  // filterable RGBA16 texture (decoded to linear in-shader). 0 / false when the
  // GPU lacks it — then the cached preview falls back to the CPU-linearised float path.
  private haveNorm16 = false;
  private norm16Format = 0;
  // Active render pipeline + stage signatures: compared on every render to
  // detect when recompilation is needed (pipeline change or stage enable/disable).
  private pipelineSig = "";
  private stageSig = "";
  private pipelineSkipBase = false;
  private programCache = new Map<string, PipelineProgram>();
  private vao: WebGLVertexArrayObject | null = null;
  private quadBuf: WebGLBuffer | null = null;
  private injectedStages: ProcessingStageContribution[] | null = null;
  private injectedPipeline: ResolvedPipeline | null = null;

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
      // this driver — fall back silently to the RGBA16F float path.
    }

    this.haveColorBufferFloat = !!gl.getExtension("EXT_color_buffer_float");

    const p = this.injectedPipeline ?? resolveActivePipeline();
    const { injection, sig: sSig, bindings, textureBindings, prepass, hasNoiseReduction } = buildStageInjection(
      this.injectedStages ?? undefined,
    );
    this.contributedBindings = bindings;
    this.stageTextureBindings = textureBindings;
    this.prepassStages = prepass;
    this.hasContribNR = hasNoiseReduction;
    const entry = this.entryFor(p, injection, sSig);
    this.program = entry.program;
    this.uniforms = entry.uniforms;
    this.pipelineSkipBase = entry.skipBase;
    this.pipelineSig = p.sig;
    this.stageSig = sSig;
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
    const sig = coverageSignature(items);
    if (sig === prevSig) return { sig, channelOf: tex === this.maskTexture ? this.maskChannelOf : this.retouchChannelOf };
    const aspect = this.imageHeight > 0 ? this.imageWidth / this.imageHeight : 1;
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

  private updateMaskTexture(masks: Mask[]) {
    // Brush coverage now comes from brush COMPONENTS across all masks (the atlas
    // packs up to four into RGBA). Keyed by component id.
    const items: CoverageItem[] = [];
    for (const m of masks) {
      for (const c of m.components) {
        if (c.kind === "brush" && c.brush) items.push({ id: c.id, dabs: c.brush.dabs });
      }
    }
    const r = this.updateCoverageTexture(this.maskTexture, items, this.maskSig);
    this.maskSig = r.sig;
    this.maskChannelOf = r.channelOf;
  }

  private updateRetouchTexture(retouch: RetouchSpot[]) {
    const items: CoverageItem[] = retouch
      .filter((s) => s.shape === "brush" && s.dabs && s.dabs.length > 0)
      .map((s) => ({ id: s.id, dabs: s.dabs! }));
    const r = this.updateCoverageTexture(this.retouchTexture, items, this.retouchSig);
    this.retouchSig = r.sig;
    this.retouchChannelOf = r.channelOf;
  }

  // Recompute the content-aware fill when a heal region's geometry changes.
  // Guarded by a geometry signature; cleared entirely when nothing is healed.
  private updateHealFill(retouch: RetouchSpot[]) {
    if (!CONTENT_AWARE_HEAL) {
      this.haveHealFill = false;
      this.healSig = "";
      return;
    }
    const heals = retouch;
    if (heals.length === 0 || !this.fillSrc) {
      this.haveHealFill = false;
      this.healSig = "";
      return;
    }
    const sig =
      `${this.fillW}x${this.fillH}|` +
      heals
        .map((s) =>
          s.shape === "brush" && s.dabs
            ? "b" + s.dabs.map((d) => `${d.x.toFixed(3)},${d.y.toFixed(3)},${d.radius.toFixed(3)}`).join(";")
            : `c${s.dstX.toFixed(3)},${s.dstY.toFixed(3)},${s.radius.toFixed(3)}`,
        )
        .join("|");
    if (sig === this.healSig && this.haveHealFill) return;
    this.healSig = sig;

    const W = this.fillW, H = this.fillH;
    const aspect = this.imageHeight > 0 ? this.imageWidth / this.imageHeight : 1;
    const hole = new Uint8Array(W * H);
    let any = false;
    for (const s of heals) {
      if (s.shape === "brush" && s.dabs) {
        for (const d of s.dabs) { stampDisc(hole, W, H, aspect, d.x, d.y, d.radius); any = true; }
      } else {
        stampDisc(hole, W, H, aspect, s.dstX, s.dstY, s.radius);
        any = true;
      }
    }
    if (!any) { this.haveHealFill = false; return; }

    const filled = contentAwareFill(this.fillSrc, W, H, hole, { patch: 3, iters: 4 });
    const gl = this.gl;
    if (!this.healFillTex) this.healFillTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.healFillTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, filled);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.haveHealFill = true;
  }

  // Program + uniform locations for a pipeline + stage set, cached by combined
  // signature. A bad custom transform falls back to the built-in entry — cached
  // under the failing sig too, so it isn't recompiled (and re-logged) every frame.
  private entryFor(p: ResolvedPipeline, stageInj: StageInjection, sSig: string): PipelineProgram {
    const cacheKey = `${p.sig}|${sSig}`;
    let e = this.programCache.get(cacheKey);
    if (e) return e;
    try {
      const program = this.createProgram(VERTEX_SHADER, buildFragmentShader(p.glsl, stageInj));
      e = { program, uniforms: this.cacheUniformsFor(program), skipBase: p.skipBaseCurve };
    } catch (err) {
      if (!p.glsl) throw err; // built-in must compile
      console.error(`[pipeline] "${p.id}" failed to compile; using built-in:`, err);
      e = this.entryFor(BUILTIN_RESOLVED, stageInj, sSig);
    }
    this.programCache.set(cacheKey, e);
    return e;
  }

  private createProgram(vsSrc: string, fsSrc: string): WebGLProgram {
    const gl = this.gl;
    const vs = this.compileShader(gl.VERTEX_SHADER, vsSrc);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSrc);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    // Pin attribute locations so the shared quad VAO is valid for every
    // pipeline variant of the program.
    gl.bindAttribLocation(program, ATTR_POS, "aPos");
    gl.bindAttribLocation(program, ATTR_UV, "aUv");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      throw new Error(`Program link failed: ${log}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
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
      "uRawHistogram",
      "uShowClipping",
      "uVizMask",
      "uVizColor",
      "uVizStrength",
      "uSharpenViz",
      "uExposure",
      "uContrast",
      "uHighlights",
      "uShadows",
      "uWhites",
      "uBlacks",
      "uTexture",
      "uClarity",
      "uDehaze",
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
      // Lens corrections — manual sliders
      "uLensDistortion",
      "uLensCA",
      "uLensDefringe",
      "uLensVignetting",
      // Lens corrections — profile-based
      "uLensDistModel",
      "uLensDistA",
      "uLensDistB",
      "uLensDistC",
      "uLensTcaModel",
      "uLensTcaKr",
      "uLensTcaKb",
      "uLensTcaBr",
      "uLensTcaCr",
      "uLensTcaBb",
      "uLensTcaCb",
      "uLensVigK1",
      "uLensVigK2",
      "uLensVigK3",
      "uLensAutoCropScale",
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
      // Masks + retouch
      "uImageAspect",
      "uMaskCount",
      "uMaskTex",
      "uMaskCurves",
      // Array bases set in one call via uniform*v.
      "uMaskHasHsl[0]",
      "uMaskHasCurve[0]",
      "uMaskHsl[0]",
      "uSpotCount",
      "uRetouchTex",
      "uRetouchCount",
      "uDevelopedSrc",
      "uHaveDeveloped",
      "uApplyRetouch",
      "uHealFill",
      "uHaveHealFill",
      "uMembraneHeal",
      "uPatchPass",
    ];
    // Per-mask array uniforms (queried by indexed name).
    for (let i = 0; i < MAX_MASKS; i++) {
      for (const base of ["uMaskInvert", "uMaskOpacity", "uMaskAdj0", "uMaskAdj1", "uMaskAdj2"]) {
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
      u[`uRetouchRadius[${i}]`] = gl.getUniformLocation(program, `uRetouchRadius[${i}]`);
    }
    for (const name of names) {
      u[name] = gl.getUniformLocation(program, name);
    }
    // Extension-contributed stage uniforms, keyed by qualified key so render()
    // can resolve location + value together from the param bag.
    for (const b of this.contributedBindings) {
      u[b.qualifiedKey] = gl.getUniformLocation(program, b.glslName);
    }
    // Prepass result samplers (one per passes-bearing stage).
    for (const ps of this.prepassStages) {
      u[ps.resultUniform] = gl.getUniformLocation(program, ps.resultUniform);
    }
    // Extension stage-texture samplers (LUT atlases), keyed by qualified key.
    for (const tb of this.stageTextureBindings) {
      u[tb.qualifiedKey] = gl.getUniformLocation(program, tb.glslName);
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

  setImage(
    image:
      | ImageBitmap
      | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean }
      | { kind: "srgb16"; data: Uint16Array; width: number; height: number },
    maxEdge: number = MAX_EDGE,
    isFallbackPreview = false,
    // True when an 8-bit bitmap is actually a linear-encoded RAW source (the
    // cached develop preview) rather than a camera-rendered image. Such a source
    // still needs the default base tone curve, same as the live float decode.
    baseCurveForBitmap = false,
    // Opt-in (thumb renderer only): cap an oversized srgb16 source to maxEdge.
    // The fast norm16 path uploads srgb16 at full resolution; for thumbnails that
    // wastes GPU memory, so route oversized srgb16 through the capping float path
    // instead. The main renderer leaves this off to keep full-res zoom detail.
    capSrgb16 = false,
  ) {
    const gl = this.gl;
    this.maxEdge = maxEdge;

    // The single imageTexture is reused across opens. The float path writes N
    // RGBA16F mip levels by hand; a later norm16/8-bit load only rewrites level 0,
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
    let mipsBuilt = false;
    let uploaded = false;
    const srgb16Oversized =
      "kind" in image && image.kind === "srgb16" &&
      Math.max(image.width, image.height) > maxEdge;
    if ("kind" in image && image.kind === "srgb16" && this.haveNorm16 && !(capSrgb16 && srgb16Oversized)) {
      // Cached develop preview, GPU path — upload the 16-bit sRGB data straight to a
      // normalized RGBA16 texture and let the shader's srgbToLinear (uLinear == false)
      // do the decode while sampling. No per-sample CPU math, and the texture is half
      // the bytes / upload of the old Float32 (RGBA16F) route. Full 16-bit precision,
      // so a big exposure push still doesn't posterise. RGBA16 is colour-renderable
      // AND filterable, so unlike RGBA16F the GPU can build the mip chain itself.
      this.imageWidth = image.width;
      this.imageHeight = image.height;
      this.linear = false;          // texture is sRGB-encoded; shader decodes it
      this.isFallbackPreview = false;
      this.applyBaseCurve = true;   // cached source is scene-linear RAW -> needs base curve
      gl.texImage2D(
        gl.TEXTURE_2D, 0, this.norm16Format, image.width, image.height, 0,
        gl.RGBA, gl.UNSIGNED_SHORT, image.data,
      );
      while (gl.getError() !== gl.NO_ERROR) {} // clear prior errors
      gl.generateMipmap(gl.TEXTURE_2D);
      if (gl.getError() !== gl.NO_ERROR) {
        // The 2x2 constructor probe passed, but this driver fails generateMipmap
        // on the full-size RGBA16 texture (returns 0x0502). An incomplete mip
        // chain samples as black, so abandon norm16 for the session and fall
        // through to the CPU-linearised float path (manual mips, known-good).
        while (gl.getError() !== gl.NO_ERROR) {}
        this.haveNorm16 = false;
      } else {
        mipsBuilt = true;
        uploaded = true;
        // Heal / content-aware-fill source is 8-bit sRGB; the cached data is already
        // sRGB, so the high byte of each 16-bit sample is the 8-bit value directly.
        const u8 = new Uint8Array(image.data.length);
        for (let i = 0; i < image.data.length; i++) u8[i] = image.data[i] >> 8;
        const ds = downsampleRGBA(u8, image.width, image.height);
        this.fillSrc = ds.data; this.fillW = ds.w; this.fillH = ds.h; this.healSig = "";
        setHealSourceImage(ds.data, ds.w, ds.h);
      }
    }
    if (!uploaded && "kind" in image) {
      // Linear float (RAW) path — upload as RGBA16F so the develop pipeline keeps
      // ~10-bit precision AND real HDR headroom. The previous code quantised to 8-bit
      // sRGB (mipmaps need a filterable+renderable format), which meant a +5 exposure
      // (×32) stretched ~50 code values across the bright sky into visible bands, and
      // because R/G/B quantise independently their ratios stepped → rainbow posterising.
      // 16-bit float removes that. WebGL2 can't generateMipmap on RGBA16F, so the mip
      // chain for the local-contrast taps is built by hand below.
      //
      // A cached (srgb16) preview also lands here when the GPU lacks EXT_texture_norm16:
      // it's linearised on the CPU (LUT) so it can ride the same scene-linear float path.
      const fsrc = image.kind === "srgb16" ? srgb16ToFloatImage(image) : image;
      // Bound the working texture to the develop cap. The live RAW decode is
      // full sensor resolution; uploading it whole (plus the hand-built mip
      // chain and heal pass) is what exhausted memory on low-RAM machines.
      const src0 = fsrc.data instanceof Float32Array ? fsrc.data : new Float32Array(fsrc.data);
      const fimg = capFloatToEdge(src0, fsrc.width, fsrc.height, maxEdge);
      this.imageWidth = fimg.width;
      this.imageHeight = fimg.height;
      // Texture now holds true linear scene values, so the shader must NOT sRGB-decode.
      this.linear = true;
      this.isFallbackPreview = fsrc.isFallbackPreview ?? isFallbackPreview;
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
      mipsBuilt = true;
      {
        // Heal / content-aware-fill source stays 8-bit sRGB (its own pipeline).
        const u8 = new Uint8Array(f0.length);
        for (let i = 0; i < f0.length; i++) {
          const v = Math.max(0, f0[i]);
          const enc = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
          u8[i] = Math.round(Math.min(255, enc * 255));
        }
        const ds = downsampleRGBA(u8, fimg.width, fimg.height);
        this.fillSrc = ds.data; this.fillW = ds.w; this.fillH = ds.h; this.healSig = "";
        setHealSourceImage(ds.data, ds.w, ds.h);
      }
    } else if (!("kind" in image)) {
      // 8-bit sRGB bitmap path
      this.imageWidth = image.width;
      this.imageHeight = image.height;
      this.linear = false;
      this.isFallbackPreview = isFallbackPreview;
      // Camera-rendered bitmaps already carry a tone curve; the cached develop
      // preview is linear-encoded RAW and needs the base curve added.
      this.applyBaseCurve = baseCurveForBitmap;
      // Orientation is handled by the vertex shader (V flip). Do NOT use
      // UNPACK_FLIP_Y_WEBGL: it is unreliable for ImageBitmap sources.
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image,
      );
      {
        const ds = downsampleDrawable(image, image.width, image.height);
        this.fillSrc = ds.data; this.fillW = ds.w; this.fillH = ds.h; this.healSig = "";
        setHealSourceImage(ds.data, ds.w, ds.h);
      }
    }
    // Build the mip chain for local-contrast blurs (Texture/Clarity/Dehaze).
    // The float (RGBA16F) path supplies its mips by hand, and the norm16 path
    // already called generateMipmap; both set mipsBuilt, so only the 8-bit bitmap
    // path needs it here.
    if (!mipsBuilt) gl.generateMipmap(gl.TEXTURE_2D);
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
      | { kind: "srgb16"; data: Uint16Array; width: number; height: number },
    maxEdge: number = MAX_EDGE,
    isFallbackPreview = false,
    baseCurveForBitmap = false,
    // When false, the source is uploaded into the cache but the previously-active
    // source is re-bound afterwards — used to prefetch neighbours without
    // disturbing the displayed image.
    bind = true,
    // Cap oversized srgb16 to maxEdge (thumb renderer only — see setImage).
    capSrgb16 = false,
  ) {
    const prevKey = this.currentSourceKey;
    // Drop any stale entry for this key (e.g. re-decode after an edit changed the
    // pixels) so we don't leak its texture.
    this.dropSource(key);
    this.setImage(image, maxEdge, isFallbackPreview, baseCurveForBitmap, capSrgb16);
    // setImage built into this.imageTexture and marked it owned; hand it to the cache.
    const entry: SourceEntry = {
      tex: this.imageTexture,
      width: this.imageWidth,
      height: this.imageHeight,
      linear: this.linear,
      applyBaseCurve: this.applyBaseCurve,
      isFallbackPreview: this.isFallbackPreview,
      fill: this.fillSrc ? { data: this.fillSrc, w: this.fillW, h: this.fillH } : null,
      bytes: this.estimateSourceBytes(this.imageWidth, this.imageHeight, this.linear),
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
  // if the key isn't cached (caller should decode + uploadSource).
  bindSource(key: string): boolean {
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
    this.linear = e.linear;
    this.applyBaseCurve = e.applyBaseCurve;
    this.isFallbackPreview = e.isFallbackPreview;
    // Restore the heal/content-aware-fill source for this image and force a
    // recompute on the next setParams (the global heal singleton is shared).
    if (e.fill) {
      this.fillSrc = e.fill.data;
      this.fillW = e.fill.w;
      this.fillH = e.fill.h;
      setHealSourceImage(e.fill.data, e.fill.w, e.fill.h);
    } else {
      this.fillSrc = null;
    }
    this.healSig = "";
    this.haveHealFill = false;
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

  private estimateSourceBytes(w: number, h: number, linear: boolean): number {
    // RGBA16F (float RAW) / RGBA16 (norm16) = 8 bytes/px; 8-bit bitmap = 4.
    // ×4/3 accounts for the mip chain.
    const bpp = linear || this.haveNorm16 ? 8 : 4;
    return Math.round(w * h * bpp * (4 / 3));
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

  setLensProfile(profile: import("@/lens-profiles/types").ResolvedProfile | null) {
    this.lensProfile = profile;
    this.updateAutoCropScale();
  }

  private updateAutoCropScale() {
    const lc = this.params?.lensCorrection;
    const lp = this.lensProfile;
    if (lc?.mode === "profile" && lp?.distortion && lc.distortionEnabled) {
      const aspect = this.imageWidth && this.imageHeight
        ? this.imageWidth / this.imageHeight : 1.5;
      this.autoCropScale = computeAutoCropScale(
        lp.distortion.model, lp.distortion.k, lc.distortion, aspect,
      );
    } else if (lc?.mode === "manual" && Math.abs(lc.distortion) > 0.001) {
      this.autoCropScale = 1; // manual mode: no auto-crop (user controls distortion directly)
    } else {
      this.autoCropScale = 1;
    }
  }

  setParams(params: DevelopParams) {
    this.params = params;
    this.updateAutoCropScale();
    this.updateMaskTexture(params.masks);
    this.updateMaskCurveTexture(params.masks);
    const visibleRetouch = params.retouch.filter((s) => s.visible !== false);
    this.updateRetouchTexture(visibleRetouch);
    this.updateHealFill(visibleRetouch);
    const lut = buildRGBCurveLUT(params.toneCurve);
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
    // NOTE: resize happens in render(), not here. Resizing the canvas clears
    // it, and setParams runs a frame before the coalesced render — doing it
    // here painted a black frame on every crop/straighten/transform change.
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

  private syncPipeline() {
    const p = this.injectedPipeline ?? resolveActivePipeline();
    const { injection, sig: sSig, bindings, textureBindings, prepass, hasNoiseReduction } = buildStageInjection(
      this.injectedStages ?? undefined,
    );
    if (p.sig === this.pipelineSig && sSig === this.stageSig) return;
    this.contributedBindings = bindings;
    this.stageTextureBindings = textureBindings;
    this.prepassStages = prepass;
    this.hasContribNR = hasNoiseReduction;
    // Pass programs are keyed by stageSig; a stage-set change invalidates them
    // and the prepass result cache.
    if (sSig !== this.stageSig) {
      for (const e of this.passPrograms.values()) this.gl.deleteProgram(e.program);
      this.passPrograms.clear();
      this.prepassSigs.clear();
    }
    const e = this.entryFor(p, injection, sSig);
    this.program = e.program;
    this.uniforms = e.uniforms;
    this.pipelineSkipBase = e.skipBase;
    this.pipelineSig = p.sig;
    this.stageSig = sSig;
  }

  render() {
    if (!this.hasImage || !this.params) return;
    this.syncPipeline();
    this.resize();
    const gl = this.gl;
    const p = this.params;
    const u = this.uniforms;

    gl.useProgram(this.program);

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
    // A replacement pipeline that brings its own tone curve (AgX, ACES, …)
    // suppresses the default RAW base curve so it sees true scene-linear input.
    gl.uniform1i(
      u.uApplyBaseCurve,
      this.applyBaseCurve && !this.pipelineSkipBase ? 1 : 0,
    );
    gl.uniform1i(u.uShowClipping, this.showClipping);
    gl.uniform3f(u.uOutsideColor, this.outsideColor[0], this.outsideColor[1], this.outsideColor[2]);
    gl.uniform1i(u.uVizMask, this.vizMask);
    gl.uniform3f(u.uVizColor, this.vizColor[0], this.vizColor[1], this.vizColor[2]);
    gl.uniform1f(u.uVizStrength, this.vizStrength);
    gl.uniform1i(u.uSharpenViz, this.sharpenViz);
    gl.uniform1f(u.uExposure, p.exposure);
    gl.uniform1f(u.uContrast, p.contrast);
    gl.uniform1f(u.uHighlights, p.highlights);
    gl.uniform1f(u.uShadows, p.shadows);
    gl.uniform1f(u.uWhites, p.whites);
    gl.uniform1f(u.uBlacks, p.blacks);
    gl.uniform1f(u.uTexture, p.texture);
    gl.uniform1f(u.uClarity, p.clarity);
    gl.uniform1f(u.uDehaze, p.dehaze);
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

    const lc = p.lensCorrection;
    const lp = this.lensProfile;
    const useProfile = lc.mode === "profile" && lp;

    // Manual sliders — in profile mode, distortion/CA/vignetting sliders are
    // additive fine-tuning; in manual mode they are the sole source.
    gl.uniform1f(u.uLensDistortion,   lc.mode !== "off" ? lc.distortion : 0);
    gl.uniform1f(u.uLensCA,           lc.mode === "manual" ? lc.chromaticAberration : 0);
    gl.uniform1f(u.uLensDefringe,     lc.mode !== "off" ? lc.defringe : 0);
    gl.uniform1f(u.uLensVignetting,   lc.mode === "manual" ? lc.vignetting : 0);

    // Profile-based uniforms
    if (useProfile && lp.distortion && lc.distortionEnabled) {
      const d = lp.distortion;
      const modelInt = d.model === "poly3" ? 1 : d.model === "poly5" ? 2 : 3;
      gl.uniform1i(u.uLensDistModel,  modelInt);
      gl.uniform1f(u.uLensDistA,      d.k[0] ?? 0);
      gl.uniform1f(u.uLensDistB,      d.k.length > 1 ? d.k[1] : d.k[0] ?? 0);
      gl.uniform1f(u.uLensDistC,      d.k[2] ?? 0);
    } else {
      gl.uniform1i(u.uLensDistModel,  0);
      gl.uniform1f(u.uLensDistA,      0);
      gl.uniform1f(u.uLensDistB,      0);
      gl.uniform1f(u.uLensDistC,      0);
    }

    if (useProfile && lp.tca && lc.caEnabled) {
      const t = lp.tca;
      gl.uniform1i(u.uLensTcaModel,   t.model === "linear" ? 1 : 2);
      if (t.model === "linear") {
        gl.uniform1f(u.uLensTcaKr,    t.k[0] ?? 1);
        gl.uniform1f(u.uLensTcaKb,    t.k[1] ?? 1);
        gl.uniform1f(u.uLensTcaBr,    0);
        gl.uniform1f(u.uLensTcaCr,    0);
        gl.uniform1f(u.uLensTcaBb,    0);
        gl.uniform1f(u.uLensTcaCb,    0);
      } else {
        // poly3: [br, cr, vr, bb, cb, vb]
        gl.uniform1f(u.uLensTcaBr,    t.k[0] ?? 0);
        gl.uniform1f(u.uLensTcaCr,    t.k[1] ?? 0);
        gl.uniform1f(u.uLensTcaKr,    t.k[2] ?? 1);
        gl.uniform1f(u.uLensTcaBb,    t.k[3] ?? 0);
        gl.uniform1f(u.uLensTcaCb,    t.k[4] ?? 0);
        gl.uniform1f(u.uLensTcaKb,    t.k[5] ?? 1);
      }
    } else {
      gl.uniform1i(u.uLensTcaModel,   0);
      gl.uniform1f(u.uLensTcaKr,      1);
      gl.uniform1f(u.uLensTcaKb,      1);
      gl.uniform1f(u.uLensTcaBr,      0);
      gl.uniform1f(u.uLensTcaCr,      0);
      gl.uniform1f(u.uLensTcaBb,      0);
      gl.uniform1f(u.uLensTcaCb,      0);
    }

    if (useProfile && lp.vignetting && lc.vignetteEnabled) {
      gl.uniform1f(u.uLensVigK1,      lp.vignetting.k[0]);
      gl.uniform1f(u.uLensVigK2,      lp.vignetting.k[1]);
      gl.uniform1f(u.uLensVigK3,      lp.vignetting.k[2]);
    } else {
      gl.uniform1f(u.uLensVigK1,      0);
      gl.uniform1f(u.uLensVigK2,      0);
      gl.uniform1f(u.uLensVigK3,      0);
    }

    // Auto-crop scale
    gl.uniform1f(u.uLensAutoCropScale, lc.autoCrop && lc.mode !== "off" ? (this.autoCropScale ?? 1) : 1);

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
      gl.uniform4f(u[`uMaskAdj2[${i}]`], a.sharpness, 0, 0, 0);
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
        gl.uniform1i(u[`uCompBrushCh[${ci}]`], this.maskChannelOf[c.id] ?? 0);
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
    const hslData = new Float32Array(MAX_MASKS * 24);
    masks.forEach((m, i) => {
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
    const brushSpots = visibleSpots
      .filter((s) => s.shape === "brush" && s.dabs && s.dabs.length > 0)
      .slice(0, MAX_RETOUCH_BRUSH);
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
      // Average dab radius drives the heal blur scale for this painted region.
      const dabs = s.dabs!;
      const avgR = dabs.reduce((sum, d) => sum + d.radius, 0) / dabs.length;
      gl.uniform1f(u[`uRetouchRadius[${i}]`], avgR);
    });

    // Content-aware heal fill (source-UV space); unused while disabled but kept
    // bound so the sampler stays valid.
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.healFillTex ?? this.imageTexture);
    gl.uniform1i(u.uHealFill, 5);
    gl.uniform1i(u.uHaveHealFill, this.haveHealFill ? 1 : 0);
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
    if (hasRetouch && this.prepareDevelopedTarget()) {
      // Pass 1 -> bake the retouch into an offscreen copy of the source, then
      // build its mip chain so the develop's blur taps read the patched pixels.
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.developedFbo);
      gl.viewport(0, 0, this.devW, this.devH);
      // Break a feedback loop: bindPrepassResults (end of the previous frame) may
      // leave developedTex bound to a prepass-result sampler unit. Rendering INTO
      // developedTex here while it's still bound as a sampler input on the active
      // program is a GL feedback loop (undefined — drivers can drop the write,
      // leaving the patched source stale, so heal edits never appear when a stage
      // with an active prepass result is registered). Detach those units first.
      for (let pu = 0; pu < MAX_PREPASS_STAGES; pu++) {
        gl.activeTexture(gl.TEXTURE0 + PREPASS_UNIT_BASE + pu);
        gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.imageTexture); // read the original source
      gl.uniform1i(u.uImage, 0);
      gl.uniform1i(u.uPatchPass, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindTexture(gl.TEXTURE_2D, this.developedTex);
      gl.generateMipmap(gl.TEXTURE_2D);

      // Prepasses (e.g. denoise) read the PATCHED source so heal happens before
      // detail; results are bound onto the main program for pass 2. The patched
      // source varies with retouch/heal geometry, so fold those into the cache key.
      this.runPrepasses(this.developedTex!, `e${this.sourceEpoch}|r${this.retouchSig}|c${circleSig}|h${this.healSig}`);
      gl.useProgram(this.program);
      this.bindPrepassResults();

      // Pass 2 -> develop from the patched copy (now the spot is already gone,
      // so texture/clarity/sharpening can't invert it). Retouch off this pass.
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.outputFbo);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.developedTex);
      gl.uniform1i(u.uImage, 0);
      gl.uniform1i(u.uPatchPass, 0);
      gl.uniform1i(u.uApplyRetouch, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    } else {
      // No retouch (or no offscreen target): single pass. The in-shader retouch
      // is the fallback when the framebuffer can't be created.
      this.runPrepasses(this.imageTexture, `e${this.sourceEpoch}`);
      gl.useProgram(this.program);
      this.bindPrepassResults();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.outputFbo);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
      gl.uniform1i(u.uImage, 0);
      gl.uniform1i(u.uPatchPass, 0);
      gl.uniform1i(u.uApplyRetouch, hasRetouch ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }

  // Render the current frame into an RGBA16F framebuffer and read back the
  // float pixels — top-down, RGBA, display-encoded in [0,1] (HDR highlights may
  // exceed 1; the caller clamps). Drives the same render() path as the canvas,
  // so all develop/extension stages are baked in. Returns null when float render
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

    // Restore main canvas framebuffer and viewport.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    return result;
  }

  readDownscaledPixels(size: number): { data: Uint8Array; w: number; h: number } | null {
    if (!this.imageWidth || !this.imageHeight) return null;
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

    // Temporarily override transform and crop to identity so we detect lines
    // in the raw image, not in an already-corrected view.
    const u = this.uniforms;
    const IDENTITY_MAT3 = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
    gl.uniform4f(u.uCrop, 0, 0, 1, 1);
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

    // Restore the real transform and crop uniforms
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

  // True when the param bag holds a non-zero value for any of this stage's keys,
  // i.e. the stage actually does something this frame. Lets an untouched denoise
  // stage cost nothing (its inline glsl early-outs on a zero amount anyway).
  private prepassActive(stageId: string): boolean {
    const prefix = stageId + ".";
    for (const [k, v] of Object.entries(this.contributedParams)) {
      if (k.startsWith(prefix) && typeof v === "number" && v !== 0) return true;
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
  // Leaves results in per-stage targets and records the unit bindings the main
  // draw applies via bindPrepassResults().
  private runPrepasses(srcTex: WebGLTexture, srcSig: string) {
    this.prepassResults = [];
    if (this.prepassStages.length === 0) return;
    const gl = this.gl;
    const { w, h } = this.prepassDims();
    const haveTargets = this.ensurePingPong(w, h);
    const baseCurve = this.applyBaseCurve && !this.pipelineSkipBase ? 1 : 0;

    let unit = PREPASS_UNIT_BASE;
    for (const stage of this.prepassStages) {
      if (unit >= PREPASS_UNIT_BASE + MAX_PREPASS_STAGES) break;
      // Inactive (or no float targets): bind the raw source as the result. The
      // inline glsl blends with amount 0, so the value is never actually used.
      if (!haveTargets || !this.prepassActive(stage.stageId)) {
        this.prepassResults.push({ resultUniform: stage.resultUniform, tex: srcTex, unit: unit++ });
        continue;
      }

      // Cache hit: nothing the prepass depends on changed — reuse the result and
      // skip the passes entirely.
      const sig = this.prepassSig(stage, srcSig, w, h, baseCurve);
      const cached = this.stageResultTargets.get(stage.stageId);
      if (cached && cached.w === w && cached.h === h && this.prepassSigs.get(stage.stageId) === sig) {
        this.prepassResults.push({ resultUniform: stage.resultUniform, tex: cached.tex, unit: unit++ });
        continue;
      }

      let readTex: WebGLTexture = srcTex;
      let prevRaw = true;            // first read linearizes + base-curves the source
      let writeIdx = 0;
      let lastIdx = 0;
      for (const pass of stage.passes) {
        const key = `${this.stageSig}|${stage.stageId}|${pass.fragmentSource.length}`;
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
      this.prepassSigs.set(stage.stageId, this.prepassSig(stage, srcSig, w, h, baseCurve));
      this.prepassResults.push({ resultUniform: stage.resultUniform, tex: target.tex, unit: unit++ });
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
    if (this.devW !== w || this.devH !== h) {
      gl.bindTexture(gl.TEXTURE_2D, this.developedTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.developedFbo);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.developedTex, 0,
      );
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (!ok) {
        this.devW = 0;
        this.devH = 0;
        return false;
      }
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
    if (this.healFillTex) gl.deleteTexture(this.healFillTex);
    gl.deleteTexture(this.maskTexture);
    gl.deleteTexture(this.retouchTexture);
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
    const programs = new Set<WebGLProgram>([this.program]);
    for (const e of this.programCache.values()) programs.add(e.program);
    for (const prog of programs) gl.deleteProgram(prog);
  }
}
