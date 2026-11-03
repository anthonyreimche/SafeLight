// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What a context can do, read once by each renderer, and the colour targets
// and sampling every pass sets up the same way.

/** The renderer's scratch unit: no develop frame reads it, so a pass can bind
 *  a texture there without lending a unit and giving it back. */
export const SCRATCH_UNIT = 7;

/** What a context can render and hold, read when a renderer is made. */
export interface Caps {
  /** EXT_color_buffer_float: half and full float textures are renderable. It
   *  sets every intermediate's working precision; without it they are RGBA8,
   *  so even a 16-bit source is crushed to 8 bits at the first pass. */
  readonly colorBufferFloat: boolean;
  /** EXT_texture_norm16's RGBA16 where a texture of it mipmaps, else 0. */
  readonly norm16: number;
  /** The largest edge one texture may have. */
  readonly maxTextureSize: number;
  /** MAX_TEXTURE_IMAGE_UNITS: the samplers one shader may declare. */
  readonly textureUnits: number;
  /** MAX_COMBINED_TEXTURE_IMAGE_UNITS: the units a sampler may read. */
  readonly combinedTextureUnits: number;
  /** MAX_FRAGMENT_UNIFORM_VECTORS: the vec4 rows a fragment shader's uniforms
   *  may fill; the develop program grows with masks and stages. */
  readonly fragmentUniformVectors: number;
}

/** The context's caps. `norm16` asks for the RGBA16 probe, which only High
 *  bit depth uses. */
export function readCaps(gl: WebGL2RenderingContext, opts: { norm16: boolean }): Caps {
  const norm16 = opts.norm16 ? mipmappableNorm16(gl) : 0;
  return {
    norm16,
    colorBufferFloat: !!gl.getExtension("EXT_color_buffer_float"),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    textureUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
    combinedTextureUnits: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
    fragmentUniformVectors: gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS),
  };
}

// Some drivers have the extension but can't generateMipmap on it; the heal
// copy then stays RGBA8. Export asks another question of norm16 (whether it
// reads back as 16-bit codes, exportNorm16Format), whatever the setting.
function mipmappableNorm16(gl: WebGL2RenderingContext): number {
  const ext: EXT_texture_norm16 | null = gl.getExtension("EXT_texture_norm16");
  if (!ext) return 0;
  const probe = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, probe);
  gl.texImage2D(gl.TEXTURE_2D, 0, ext.RGBA16_EXT, 2, 2, 0, gl.RGBA, gl.UNSIGNED_SHORT, new Uint16Array(16));
  gl.generateMipmap(gl.TEXTURE_2D);
  const error = gl.getError();
  gl.deleteTexture(probe);
  drainErrors(gl);
  return error === gl.NO_ERROR ? ext.RGBA16_EXT : 0;
}

// A lost context hands back null for every object asked of it, whatever the
// typings say; failing here names the cause instead of a TypeError further on.
export function created<T>(object: T | null): T {
  if (object === null) throw new Error("WebGL context lost");
  return object;
}

/** Empties the error queue, so the next getError reads only what follows. */
export function drainErrors(gl: WebGL2RenderingContext): void {
  while (gl.getError() !== gl.NO_ERROR) { /* one flag per error code */ }
}

// Empties the error queue and says whether it held OUT_OF_MEMORY. Other errors
// a frame raises (a stage's stray uniform call, say) don't stop an export.
export function ranOutOfMemory(gl: WebGL2RenderingContext): boolean {
  let outOfMemory = false;
  for (let error = gl.getError(); error !== gl.NO_ERROR; error = gl.getError()) {
    if (error === gl.OUT_OF_MEMORY) outOfMemory = true;
  }
  return outOfMemory;
}

/** Filters `minFilter` (default `filter`) and `filter`, clamped to the edge, on
 *  the texture bound to `target`. */
export function setSampling(
  gl: WebGL2RenderingContext,
  target: number,
  filter: number,
  minFilter: number = filter,
): void {
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, minFilter);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

/** An RGBA texture's storage: the internal format and the upload type. */
export interface TexFormat {
  readonly internalFormat: number;
  readonly type: number;
}

/** The format intermediates are drawn in: RGBA16F with float render targets,
 *  else RGBA8, clipped to [0, 1]. */
export function workingFormat(gl: WebGL2RenderingContext, float: boolean): TexFormat {
  return float
    ? { internalFormat: gl.RGBA16F, type: gl.HALF_FLOAT }
    : { internalFormat: gl.RGBA8, type: gl.UNSIGNED_BYTE };
}

/** A colour target: a texture made on the scratch unit, attached to its own
 *  framebuffer. */
export interface ColourTarget {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  /** False when the context can't render into it. */
  complete: boolean;
}

/** (Re)allocates `tex` as a w×h target of `format`, bound on the active unit,
 *  and attaches it to `fbo`, leaving no framebuffer bound. True when the
 *  context can render into it. */
export function allocateInto(
  gl: WebGL2RenderingContext,
  tex: WebGLTexture,
  fbo: WebGLFramebuffer,
  format: TexFormat,
  w: number,
  h: number,
  filter: number,
  minFilter: number = filter,
): boolean {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, format.internalFormat, w, h, 0, gl.RGBA, format.type, null);
  setSampling(gl, gl.TEXTURE_2D, filter, minFilter);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return complete;
}

/** A w×h RGBA target of `internalFormat`, sampled nearest, with no framebuffer
 *  left bound. Release it whether or not it is complete. */
export function allocateTarget(
  gl: WebGL2RenderingContext,
  internalFormat: number,
  type: number,
  w: number,
  h: number,
): ColourTarget {
  const tex = gl.createTexture();
  const fbo = gl.createFramebuffer();
  gl.activeTexture(gl.TEXTURE0 + SCRATCH_UNIT);
  const complete = allocateInto(gl, tex, fbo, { internalFormat, type }, w, h, gl.NEAREST);
  return { tex, fbo, complete };
}

// An allocation the driver refuses (out of memory, say) raises an error rather
// than leaving the framebuffer incomplete, so the queue is emptied first to
// read only the allocation's, and read even for an incomplete target, which
// would otherwise leave its error for the next reader.
export function allocateChecked(
  gl: WebGL2RenderingContext,
  internalFormat: number,
  type: number,
  w: number,
  h: number,
): { target: ColourTarget; ok: boolean } {
  drainErrors(gl);
  const target = allocateTarget(gl, internalFormat, type, w, h);
  return { target, ok: gl.getError() === gl.NO_ERROR && target.complete };
}

/** Frees a target, leaving no framebuffer bound and TEXTURE0 active. */
export function releaseTarget(gl: WebGL2RenderingContext, target: ColourTarget): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(target.fbo);
  gl.activeTexture(gl.TEXTURE0 + SCRATCH_UNIT);
  gl.deleteTexture(target.tex);
  gl.activeTexture(gl.TEXTURE0);
}
