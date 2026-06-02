import type { DevelopParams } from "@/catalog/types";
import { DEFAULT_CROP, HSL_CHANNELS } from "@/catalog/types";
import { buildRGBCurveLUT } from "../curve";
import { buildInverseTransform, mat3ColumnMajor } from "../transform";
import { FRAGMENT_SHADER, VERTEX_SHADER } from "./shaders";

// Default cap on render resolution for interactive performance. Export passes
// a larger value (or the image's own long edge) to render at full size.
const MAX_EDGE = 2560;

export class WebGLRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private imageTexture: WebGLTexture;
  private curveTexture: WebGLTexture;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private params: DevelopParams | null = null;
  private hasImage = false;
  private imageWidth = 0;
  private imageHeight = 0;
  private maxEdge = MAX_EDGE;
  private linear = false;
  private isFallbackPreview = false;

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
    ];
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
    } else {
      // 8-bit sRGB bitmap path
      this.imageWidth = image.width;
      this.imageHeight = image.height;
      this.linear = false;
      this.isFallbackPreview = isFallbackPreview;
      // Orientation is handled by the vertex shader (V flip). Do NOT use
      // UNPACK_FLIP_Y_WEBGL: it is unreliable for ImageBitmap sources.
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image,
      );
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

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  dispose() {
    const gl = this.gl;
    gl.deleteTexture(this.imageTexture);
    gl.deleteTexture(this.curveTexture);
    gl.deleteProgram(this.program);
  }
}
