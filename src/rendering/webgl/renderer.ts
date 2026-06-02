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
    // pos.xy, uv.xy — two triangles covering the viewport.
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
      "uExposure",
      "uContrast",
      "uHighlights",
      "uShadows",
      "uWhites",
      "uBlacks",
      "uTexture",
      "uClarity",
      "uDehaze",
      "uVibrance",
      "uSaturation",
      "uTemperature",
      "uTint",
      "uHslHue",
      "uHslSat",
      "uHslLum",
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

  setImage(bitmap: ImageBitmap, maxEdge: number = MAX_EDGE) {
    const gl = this.gl;
    this.imageWidth = bitmap.width;
    this.imageHeight = bitmap.height;
    this.maxEdge = maxEdge;

    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
    // Orientation is handled by the vertex shader (it flips V). We deliberately
    // do NOT use UNPACK_FLIP_Y_WEBGL: it is unreliable for ImageBitmap sources.
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      bitmap,
    );
    // Build the mip chain for the local-contrast (Texture/Clarity/Dehaze) blurs.
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

    gl.uniform1f(u.uExposure, p.exposure);
    gl.uniform1f(u.uContrast, p.contrast);
    gl.uniform1f(u.uHighlights, p.highlights);
    gl.uniform1f(u.uShadows, p.shadows);
    gl.uniform1f(u.uWhites, p.whites);
    gl.uniform1f(u.uBlacks, p.blacks);
    gl.uniform1f(u.uTexture, p.texture);
    gl.uniform1f(u.uClarity, p.clarity);
    gl.uniform1f(u.uDehaze, p.dehaze);
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

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  dispose() {
    const gl = this.gl;
    gl.deleteTexture(this.imageTexture);
    gl.deleteTexture(this.curveTexture);
    gl.deleteProgram(this.program);
  }
}
