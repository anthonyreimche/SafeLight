import type { DevelopParams, Mask, MaskAdjustments, RetouchSpot } from "@/catalog/types";
import {
  DEFAULT_CROP,
  HSL_CHANNELS,
  MAX_MASKS,
  MAX_RETOUCH,
  MAX_RETOUCH_BRUSH,
} from "@/catalog/types";
import { buildRGBCurveLUT } from "../curve";
import { buildInverseTransform, mat3ColumnMajor } from "../transform";
import { FRAGMENT_SHADER, VERTEX_SHADER } from "./shaders";
import { bakeCoverage, coverageSignature, type CoverageItem } from "./mask-coverage";
import { contentAwareFill } from "../content-aware-fill";
import { setHealSourceImage } from "../heal-source";

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

export class WebGLRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private imageTexture: WebGLTexture;
  private curveTexture: WebGLTexture;
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
  private hasImage = false;
  private imageWidth = 0;
  private imageHeight = 0;
  private maxEdge = MAX_EDGE;
  private linear = false;
  private isFallbackPreview = false;
  private applyBaseCurve = false;

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

    this.program = this.createProgram(VERTEX_SHADER, FRAGMENT_SHADER);
    this.setupQuad();
    this.cacheUniforms();

    this.imageTexture = this.createTexture();
    this.curveTexture = gl.createTexture();
    this.initCurveTexture();
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
    const items: CoverageItem[] = masks
      .filter((m) => m.type === "brush" && m.brush)
      .map((m) => ({ id: m.id, dabs: m.brush!.dabs }));
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
    const heals = retouch.filter((s) => s.mode === "heal");
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

  private createProgram(vsSrc: string, fsSrc: string): WebGLProgram {
    const gl = this.gl;
    const vs = this.compileShader(gl.VERTEX_SHADER, vsSrc);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSrc);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
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
    // pos.xy, uv.xy -- two triangles covering the viewport.
    const data = new Float32Array([
      -1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, -1, 1, 0, 1, 1, -1, 1, 0, 1, 1, 1,
      1,
    ]);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

    const posLoc = gl.getAttribLocation(this.program, "aPos");
    const uvLoc = gl.getAttribLocation(this.program, "aUv");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(uvLoc);
    gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);
  }

  private cacheUniforms() {
    const gl = this.gl;
    const names = [
      "uImage",
      "uCurve",
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
    // Per-element mask/retouch array uniforms (queried by indexed name).
    for (let i = 0; i < MAX_MASKS; i++) {
      for (const base of [
        "uMaskType",
        "uMaskInvert",
        "uMaskBrushCh",
        "uMaskOpacity",
        "uMaskGeoA",
        "uMaskGeoB",
        "uMaskAdj0",
        "uMaskAdj1",
        "uMaskAdj2",
      ]) {
        const name = `${base}[${i}]`;
        this.uniforms[name] = gl.getUniformLocation(this.program, name);
      }
    }
    for (let i = 0; i < MAX_RETOUCH; i++) {
      this.uniforms[`uSpotA[${i}]`] = gl.getUniformLocation(this.program, `uSpotA[${i}]`);
      this.uniforms[`uSpotB[${i}]`] = gl.getUniformLocation(this.program, `uSpotB[${i}]`);
      this.uniforms[`uSpotC[${i}]`] = gl.getUniformLocation(this.program, `uSpotC[${i}]`);
      this.uniforms[`uSpotTint[${i}]`] = gl.getUniformLocation(this.program, `uSpotTint[${i}]`);
    }
    for (let i = 0; i < MAX_RETOUCH_BRUSH; i++) {
      this.uniforms[`uRetouchCh[${i}]`] = gl.getUniformLocation(this.program, `uRetouchCh[${i}]`);
      this.uniforms[`uRetouchData[${i}]`] = gl.getUniformLocation(this.program, `uRetouchData[${i}]`);
      this.uniforms[`uRetouchRadius[${i}]`] = gl.getUniformLocation(this.program, `uRetouchRadius[${i}]`);
    }
    for (const name of names) {
      this.uniforms[name] = gl.getUniformLocation(this.program, name);
    }
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
    image: ImageBitmap | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean },
    maxEdge: number = MAX_EDGE,
    isFallbackPreview = false,
    // True when an 8-bit bitmap is actually a linear-encoded RAW source (the
    // cached develop preview) rather than a camera-rendered image. Such a source
    // still needs the default base tone curve, same as the live float decode.
    baseCurveForBitmap = false,
  ) {
    const gl = this.gl;
    this.maxEdge = maxEdge;

    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
    if ("kind" in image) {
      // Linear float (RAW) path — convert to RGBA8 for upload.
      // RGBA16F does not support generateMipmap in WebGL2, which breaks
      // Texture/Clarity/Dehaze. The shader reads these as linear (uLinear=true),
      // so no sRGB decode is applied. Precision loss vs 32-bit is acceptable
      // since the display pipeline is 8-bit anyway.
      this.imageWidth = image.width;
      this.imageHeight = image.height;
      // Store gamma-encoded (sRGB) rather than linear values so that shadow
      // detail survives the float→uint8 quantisation. In linear space, shadow
      // values in [0, 0.04] collapse to only ~10 uint8 steps; sRGB gamma
      // maps that same range to ~90 steps (8-9× more precision). The shader's
      // srgbToLinear path decodes them back to linear before any edits apply.
      // uLinear is therefore false: the texture is sRGB-encoded, not linear.
      this.linear = false;
      this.isFallbackPreview = image.isFallbackPreview ?? isFallbackPreview;
      // Real full-res RAW decode (not the pseudo-linear JPEG fallback) renders
      // scene-linear and flat; add the default tone curve to match other views.
      this.applyBaseCurve = !this.isFallbackPreview;
      const u8 = new Uint8Array(image.data.length);
      for (let i = 0; i < image.data.length; i++) {
        const v = Math.max(0, image.data[i]);
        const enc = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
        u8[i] = Math.round(Math.min(255, enc * 255));
      }
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA, image.width, image.height, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, u8,
      );
      {
        const ds = downsampleRGBA(u8, image.width, image.height);
        this.fillSrc = ds.data; this.fillW = ds.w; this.fillH = ds.h; this.healSig = "";
        setHealSourceImage(ds.data, ds.w, ds.h);
      }
    } else {
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
    gl.generateMipmap(gl.TEXTURE_2D);
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

  setParams(params: DevelopParams) {
    this.params = params;
    this.updateMaskTexture(params.masks);
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
    this.resize();
  }

  render() {
    if (!this.hasImage || !this.params) return;
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

    gl.uniform1i(u.uLinear, this.linear ? 1 : 0);
    gl.uniform1i(u.uIsFallbackPreview, this.isFallbackPreview ? 1 : 0);
    gl.uniform1i(u.uApplyBaseCurve, this.applyBaseCurve ? 1 : 0);
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
    gl.uniform1f(u.uVignetteAmount,    vig.amount);
    gl.uniform1f(u.uVignetteMidpoint,  vig.midpoint);
    gl.uniform1f(u.uVignetteRoundness, vig.roundness);
    gl.uniform1f(u.uVignetteFeather,   vig.feather);
    gl.uniform1f(u.uVignetteHighlights,vig.highlights);

    const gr = p.grain;
    gl.uniform1f(u.uGrainAmount,    gr.amount);
    gl.uniform1f(u.uGrainSize,      gr.size);
    gl.uniform1f(u.uGrainRoughness, gr.roughness);

    // Masks + retouch
    gl.uniform1f(u.uImageAspect, aspect);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    gl.uniform1i(u.uMaskTex, 2);

    const masks = p.masks.slice(0, MAX_MASKS);
    gl.uniform1i(u.uMaskCount, masks.length);
    masks.forEach((m, i) => {
      const type = m.type === "linear" ? 0 : m.type === "radial" ? 1 : 2;
      gl.uniform1i(u[`uMaskType[${i}]`], type);
      gl.uniform1i(u[`uMaskInvert[${i}]`], m.invert ? 1 : 0);
      gl.uniform1i(u[`uMaskBrushCh[${i}]`], this.maskChannelOf[m.id] ?? 0);
      gl.uniform1f(u[`uMaskOpacity[${i}]`], m.opacity / 100);
      if (m.type === "linear" && m.linear) {
        gl.uniform4f(u[`uMaskGeoA[${i}]`], m.linear.x0, m.linear.y0, m.linear.x1, m.linear.y1);
        gl.uniform4f(u[`uMaskGeoB[${i}]`], 0, 0, 0, 0);
      } else if (m.type === "radial" && m.radial) {
        gl.uniform4f(u[`uMaskGeoA[${i}]`], m.radial.cx, m.radial.cy, m.radial.rx, m.radial.ry);
        gl.uniform4f(u[`uMaskGeoB[${i}]`], m.radial.feather, m.radial.angle, 0, 0);
      } else {
        gl.uniform4f(u[`uMaskGeoA[${i}]`], 0, 0, 0, 0);
        gl.uniform4f(u[`uMaskGeoB[${i}]`], 0, 0, 0, 0);
      }
      const a: MaskAdjustments = m.adj;
      gl.uniform4f(u[`uMaskAdj0[${i}]`], a.exposure, a.contrast, a.highlights, a.shadows);
      gl.uniform4f(u[`uMaskAdj1[${i}]`], a.saturation, a.temperature, a.tint, a.clarity);
      gl.uniform4f(u[`uMaskAdj2[${i}]`], a.sharpness, 0, 0, 0);
    });

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
        s.mode === "clone" ? 1 : 0,
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
        s.mode === "clone" ? 1 : 0,
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
    if (this.developedTex) gl.deleteTexture(this.developedTex);
    if (this.developedFbo) gl.deleteFramebuffer(this.developedFbo);
    if (this.healFillTex) gl.deleteTexture(this.healFillTex);
    gl.deleteTexture(this.maskTexture);
    gl.deleteTexture(this.retouchTexture);
    gl.deleteProgram(this.program);
  }
}
