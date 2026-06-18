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
import { buildMaskCurveLUT, buildRGBCurveLUT } from "../curve";
import { buildInverseTransform, mat3ColumnMajor } from "../transform";
import { buildFragmentShader, VERTEX_SHADER, type StageInjection } from "./shaders";
import { useRegistry } from "@/extensions/registry";
import { PROCESSING_PHASE_ORDER, type ProcessingStageContribution } from "@/extensions/types";
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

// Working resolution for the CPU heal-source search (and the disabled
// content-aware fill). Big enough that thin structures (edges, lines) survive
// the downscale so the source picker can match and continue them; the search
// cost is independent of this, only the sampling fidelity changes.
const FILL_EDGE = 384;

// Experimental CPU content-aware heal fill. Off: heal copies the source verbatim
// (predictable, artifact-free). Flip to re-enable the PatchMatch synthesis path.
let CONTENT_AWARE_HEAL = false;

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
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
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

function buildStageInjection(): { injection: StageInjection; sig: string } {
  const stages = Object.values(useRegistry.getState().processingStages);
  const effects = stages
    .filter((s) => s.phase === "effects")
    .sort(stageSort);

  if (effects.length === 0) {
    return { injection: { uniforms: "", helpers: "", effects: "" }, sig: "" };
  }

  const uniformDecls: string[] = [];
  const helperBlocks: string[] = [];
  const stageBlocks: string[] = [];
  const sigParts: string[] = [];

  for (const s of effects) {
    for (const u of s.uniforms) {
      uniformDecls.push(`uniform ${u.glslType} ${u.key};`);
    }
    if (s.helpers) helperBlocks.push(s.helpers);
    stageBlocks.push(s.glsl);
    sigParts.push(s.id);
  }

  return {
    injection: {
      uniforms: uniformDecls.join("\n"),
      helpers: helperBlocks.join("\n\n"),
      effects: stageBlocks.join("\n  "),
    },
    sig: sigParts.join("|"),
  };
}

export class WebGLRenderer {
  private canvas: HTMLCanvasElement;
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
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private params: DevelopParams | null = null;
  private asShotTemperature = 6500;
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

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) {
      throw new Error("WebGL2 not supported");
    }
    this.canvas = canvas;
    this.gl = gl;

    // Normalized 16-bit textures (for the cached develop preview). Core WebGL2 has
    // no UNORM RGBA16, so this is gated on the extension; absent it, we linearise
    // the cached preview on the CPU instead (see setImage).
    // Skippable via Preferences ▸ Performance ▸ High bit-depth previews.
    //
    // Probe: some Mesa/ANGLE drivers expose EXT_texture_norm16 but return
    // GL_INVALID_OPERATION (0x0502) from generateMipmap for RGBA16 textures
    // (reported in allocateMipmapLevelsForGeneration). Test with a 2×2 dummy
    // texture before committing to the norm16 path — if the probe fails, leave
    // haveNorm16 false so the srgb16 path falls through to srgb16ToFloatImage
    // (CPU linearisation) and the plain RGBA16F mip chain that does work.
    const norm16 = getSettings().highBitDepth
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

    // Compile with the active pipeline + stages; a broken custom transform
    // falls back to the built-in so the renderer always comes up.
    const p = resolveActivePipeline();
    const { injection, sig: sSig } = buildStageInjection();
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
      "uLinear",
      "uIsFallbackPreview",
      "uApplyBaseCurve",
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
      "uLumNRDetail",
      "uLumNRContrast",
      "uColorNR",
      "uColorNRDetail",
      "uColorNRSmooth",
      "uVibrance",
      "uSaturation",
      "uTemperature",
      "uTint",
      "uAsShotTemperature",
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
      // Lens corrections
      "uLensDistortion",
      "uLensCA",
      "uLensDefringe",
      "uLensVignetting",
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
      "uPatchPass",
    ];
    // Per-mask array uniforms (queried by indexed name).
    for (let i = 0; i < MAX_MASKS; i++) {
      for (const base of [
        "uMaskInvert",
        "uMaskOpacity",
        "uMaskAdj0",
        "uMaskAdj1",
        "uMaskAdj2",
      ]) {
        const name = `${base}[${i}]`;
        u[name] = gl.getUniformLocation(program, name);
      }
    }
    // Per-component array uniforms.
    u["uCompCount"] = gl.getUniformLocation(program, "uCompCount");
    for (let i = 0; i < MAX_MASK_COMPONENTS; i++) {
      for (const base of [
        "uCompMaskIdx",
        "uCompMode",
        "uCompType",
        "uCompInvert",
        "uCompBrushCh",
        "uCompGeoA",
        "uCompGeoB",
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
  ) {
    const gl = this.gl;
    this.maxEdge = maxEdge;

    // The single imageTexture is reused across opens. The float path writes N
    // RGBA16F mip levels by hand; a later norm16/8-bit load only rewrites level 0,
    // so the leftover higher levels (wrong format/size) make the texture
    // mipmap-incomplete -> generateMipmap throws 0x0502 and the LINEAR_MIPMAP_LINEAR
    // sampler returns black on re-open. Recreate so every load starts level-clean.
    gl.deleteTexture(this.imageTexture);
    this.imageTexture = this.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
    let mipsBuilt = false;
    let uploaded = false;
    if ("kind" in image && image.kind === "srgb16" && this.haveNorm16) {
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

  // Size the output canvas to the cropped region (capped at maxEdge). Driven by
  // both setImage and setParams, since the crop lives in the develop params.
  private resize() {
    if (!this.imageWidth || !this.imageHeight) return;
    const crop = this.params?.crop ?? DEFAULT_CROP;
    const cw = this.imageWidth * crop.width;
    const ch = this.imageHeight * crop.height;
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
  setOutputColorSpace(space: ColorSpaceId) {
    this.outSpace = space;
  }

  setAsShotTemperature(kelvin: number) {
    this.asShotTemperature = kelvin >= 2000 && kelvin <= 50000 ? kelvin : 6500;
  }

  setParams(params: DevelopParams) {
    this.params = params;
    this.updateMaskTexture(params.masks);
    this.updateMaskCurveTexture(params.masks);
    this.updateRetouchTexture(params.retouch);
    this.updateHealFill(params.retouch);
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

  // Swap to the active pipeline's cached program when the selection changed
  // since the last render. Steady state is one memoized resolve and a string
  // compare; a switch is a Map lookup (compile only on first use of a sig).
  private syncPipeline() {
    const p = resolveActivePipeline();
    const { injection, sig: sSig } = buildStageInjection();
    if (p.sig === this.pipelineSig && sSig === this.stageSig) return;
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
    gl.uniform1f(u.uLumNRDetail, p.luminanceNRDetail);
    gl.uniform1f(u.uLumNRContrast, p.luminanceNRContrast);
    gl.uniform1f(u.uColorNR, p.colorNR);
    gl.uniform1f(u.uColorNRDetail, p.colorNRDetail);
    gl.uniform1f(u.uColorNRSmooth, p.colorNRSmoothness);
    gl.uniform1f(u.uVibrance, p.vibrance);
    gl.uniform1f(u.uSaturation, p.saturation);
    gl.uniform1f(u.uTemperature, p.temperature);
    gl.uniform1f(u.uTint, p.tint);
    gl.uniform1f(u.uAsShotTemperature, this.asShotTemperature);

    const crop = p.crop ?? DEFAULT_CROP;
    gl.uniform4f(u.uCrop, crop.x, crop.y, crop.width, crop.height);
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
    gl.uniform1f(u.uLensDistortion,   lc.distortion);
    gl.uniform1f(u.uLensCA,           lc.chromaticAberration);
    gl.uniform1f(u.uLensDefringe,     lc.defringe);
    gl.uniform1f(u.uLensVignetting,   lc.vignetting);

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
      gl.uniform1f(u[`uMaskOpacity[${i}]`], m.opacity / 100);
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
        const type = c.kind === "linear" ? 0 : c.kind === "radial" ? 1 : 2;
        gl.uniform1i(u[`uCompMaskIdx[${ci}]`], mi);
        gl.uniform1i(u[`uCompMode[${ci}]`], c.mode === "subtract" ? 1 : 0);
        gl.uniform1i(u[`uCompType[${ci}]`], type);
        gl.uniform1i(u[`uCompInvert[${ci}]`], c.invert ? 1 : 0);
        gl.uniform1i(u[`uCompBrushCh[${ci}]`], this.maskChannelOf[c.id] ?? 0);
        if (c.kind === "linear" && c.linear) {
          gl.uniform4f(u[`uCompGeoA[${ci}]`], c.linear.x0, c.linear.y0, c.linear.x1, c.linear.y1);
          gl.uniform4f(u[`uCompGeoB[${ci}]`], 0, 0, 0, 0);
        } else if (c.kind === "radial" && c.radial) {
          gl.uniform4f(u[`uCompGeoA[${ci}]`], c.radial.cx, c.radial.cy, c.radial.rx, c.radial.ry);
          gl.uniform4f(u[`uCompGeoB[${ci}]`], c.radial.feather, c.radial.angle, 0, 0);
        } else {
          // brush (geometry from atlas) or missing geometry
          gl.uniform4f(u[`uCompGeoA[${ci}]`], 0, 0, 0, 0);
          gl.uniform4f(u[`uCompGeoB[${ci}]`], 0, 0, 0, 0);
        }
        ci++;
      }
    }
    gl.uniform1i(u.uCompCount, ci);

    // Optional per-mask sub-panels: HSL packed as 6 vec4s per mask
    // (hue lo/hi, sat lo/hi, lum lo/hi), curve flag selects the atlas row.
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
    const circles = p.retouch.filter((s) => s.shape !== "brush").slice(0, MAX_RETOUCH);
    gl.uniform1i(u.uSpotCount, circles.length);
    circles.forEach((s, i) => {
      gl.uniform4f(u[`uSpotA[${i}]`], s.dstX, s.dstY, s.srcX, s.srcY);
      gl.uniform4f(
        u[`uSpotB[${i}]`],
        s.radius,
        s.feather / 100,
        s.opacity / 100,
        0, // reserved (was heal/clone mode)
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
      gl.uniform4f(
        u[`uSpotTint[${i}]`],
        s.recolorR ?? 0,
        s.recolorG ?? 0,
        s.recolorB ?? 0,
        0,
      );
    });

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.retouchTexture);
    gl.uniform1i(u.uRetouchTex, 3);
    const brushSpots = p.retouch
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
        0, // reserved (was heal/clone mode)
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
    gl.uniform1i(u.uHaveDeveloped, 0);

    // Keep unit 4 (uDevelopedSrc) pointed at a valid texture.
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
    gl.uniform1i(u.uDevelopedSrc, 4);

    const hasRetouch = circles.length > 0 || brushSpots.length > 0;
    if (hasRetouch && this.prepareDevelopedTarget()) {
      // Pass 1 -> bake the retouch into an offscreen copy of the source, then
      // build its mip chain so the develop's blur taps read the patched pixels.
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.developedFbo);
      gl.viewport(0, 0, this.devW, this.devH);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.imageTexture); // read the original source
      gl.uniform1i(u.uImage, 0);
      gl.uniform1i(u.uPatchPass, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindTexture(gl.TEXTURE_2D, this.developedTex);
      gl.generateMipmap(gl.TEXTURE_2D);

      // Pass 2 -> develop from the patched copy (now the spot is already gone,
      // so texture/clarity/sharpening can't invert it). Retouch off this pass.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
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
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
      gl.uniform1i(u.uImage, 0);
      gl.uniform1i(u.uPatchPass, 0);
      gl.uniform1i(u.uApplyRetouch, hasRetouch ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
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
    gl.deleteTexture(this.imageTexture);
    gl.deleteTexture(this.curveTexture);
    gl.deleteTexture(this.maskCurveTexture);
    if (this.developedTex) gl.deleteTexture(this.developedTex);
    if (this.developedFbo) gl.deleteFramebuffer(this.developedFbo);
    if (this.healFillTex) gl.deleteTexture(this.healFillTex);
    gl.deleteTexture(this.maskTexture);
    gl.deleteTexture(this.retouchTexture);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.quadBuf) gl.deleteBuffer(this.quadBuf);
    // Fallback entries can share a program under several sigs — dedupe.
    const programs = new Set<WebGLProgram>([this.program]);
    for (const e of this.programCache.values()) programs.add(e.program);
    for (const prog of programs) gl.deleteProgram(prog);
  }
}
