// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A version 2 program whose stages would pass the sampler limit keeps their
// prepass results in the layers of one TEXTURE_2D_ARRAY, so the develop shader
// reads them all through one sampler: the number of samplers a shader may
// declare (16 on ANGLE) no longer caps the stage set. A set within the limit
// keeps a texture per stage (stage-injection.ts, layersResults).

/** Each of `ids` gets a layer: the one it holds, else the lowest free one. Every
 *  layer already held is kept, so a resting stage keeps its cached result. */
export function assignLayers(
  held: ReadonlyMap<string, number>,
  ids: readonly string[],
): Map<string, number> {
  const next = new Map(held);
  const taken = new Set(held.values());
  let free = 0;
  for (const id of ids) {
    if (next.has(id)) continue;
    while (taken.has(free)) free++;
    next.set(id, free);
    taken.add(free);
  }
  return next;
}

/** The layers an array needs to hold `layers`: the highest plus one. */
export function layerDepth(layers: ReadonlyMap<string, number>): number {
  let depth = 0;
  for (const layer of layers.values()) depth = Math.max(depth, layer + 1);
  return depth;
}

/** `held` without the stages that left the set. */
export function releaseLayers(
  held: ReadonlyMap<string, number>,
  keep: ReadonlySet<string>,
): Map<string, number> {
  return new Map([...held].filter(([id]) => keep.has(id)));
}

/** A layered program's prepass results: one TEXTURE_2D_ARRAY at prepass size
 *  with a layer per stage that has run, kept while the stage stays in the stage
 *  set. */
export class StageResultLayers {
  private readonly gl: WebGL2RenderingContext;
  // RGBA16F with EXT_color_buffer_float, else RGBA8: the ping-pong targets'
  // format, so a pass's result blits into a layer unchanged.
  private readonly float: boolean;
  private layers = new Map<string, number>();
  private tex: WebGLTexture | null = null;
  private w = 0;
  private h = 0;
  private depth = 0;
  // The source epoch the layers were last reserved under.
  private epoch = 0;
  private readFbo: WebGLFramebuffer | null = null;
  private drawFbo: WebGLFramebuffer | null = null;
  private standIn: WebGLTexture | null = null;
  // The size and depth an allocation failed at. Not tried again until the stage
  // set, the size or the source changes, so a GPU out of memory isn't asked
  // every frame.
  private failed: string | null = null;

  constructor(gl: WebGL2RenderingContext, float: boolean) {
    this.gl = gl;
    this.float = float;
  }

  /** Gives each of `ids` a layer at `w`×`h` for the source `epoch` names. The
   *  array grows by the layers it lacks, copying the ones held. It starts over
   *  at a new size or a new source instead: the results it holds belong to
   *  another source, nothing can read them again, and copying them would double
   *  the peak memory for nothing. False when the array can't be had: stages that
   *  held a layer keep it, the others hold none this frame. */
  reserve(ids: readonly string[], w: number, h: number, epoch: number): boolean {
    if (this.tex && (w !== this.w || h !== this.h || epoch !== this.epoch)) {
      this.drop();
      // A growth refused beside the old array may fit without it: one more try.
      this.failed = null;
    }
    this.epoch = epoch;
    const next = assignLayers(this.layers, ids);
    const depth = layerDepth(next);
    if (depth <= this.depth) {
      this.layers = next;
      return true;
    }
    const key = `${w}x${h}x${depth}`;
    if (this.failed === key) return false;
    const tex = this.allocate(w, h, depth);
    if (!tex) {
      this.failed = key;
      return false;
    }
    if (this.tex) {
      this.copyLayers(this.tex, tex);
      this.gl.deleteTexture(this.tex);
    }
    this.tex = tex;
    this.w = w;
    this.h = h;
    this.depth = depth;
    this.layers = next;
    return true;
  }

  layer(id: string): number {
    return this.layers.get(id) ?? -1;
  }

  /** The array to sample: the layers, or a 1×1×1 stand-in while none is held,
   *  so the sampler always points at a complete texture. */
  texture(): WebGLTexture {
    return this.tex ?? this.ensureStandIn();
  }

  /** Copies the `w`×`h` result in `from` into `id`'s layer. */
  write(id: string, from: WebGLFramebuffer, w: number, h: number): void {
    const layer = this.layers.get(id);
    if (layer === undefined || !this.tex) throw new Error(`stage '${id}' holds no result layer`);
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.framebuffer("draw"));
    gl.framebufferTextureLayer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.tex, 0, layer);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  /** Frees the layers of stages not in `keep`; with none held the array goes. */
  release(keep: ReadonlySet<string>): void {
    this.layers = releaseLayers(this.layers, keep);
    this.failed = null;
    if (this.layers.size === 0) this.drop();
  }

  dispose(): void {
    this.drop();
    if (this.standIn) this.gl.deleteTexture(this.standIn);
    this.standIn = null;
  }

  private drop(): void {
    const gl = this.gl;
    if (this.tex) gl.deleteTexture(this.tex);
    if (this.readFbo) gl.deleteFramebuffer(this.readFbo);
    if (this.drawFbo) gl.deleteFramebuffer(this.drawFbo);
    this.tex = null;
    this.readFbo = null;
    this.drawFbo = null;
    this.w = 0;
    this.h = 0;
    this.depth = 0;
    this.layers = new Map();
  }

  private framebuffer(which: "read" | "draw"): WebGLFramebuffer {
    if (which === "read") return (this.readFbo ??= this.gl.createFramebuffer());
    return (this.drawFbo ??= this.gl.createFramebuffer());
  }

  // Allocated on the scratch unit 7, so no sampler unit's binding moves. Null
  // when the driver refuses it: out of memory, past MAX_ARRAY_TEXTURE_LAYERS, or
  // a framebuffer it won't complete on the array.
  private allocate(w: number, h: number, depth: number): WebGLTexture | null {
    const gl = this.gl;
    while (gl.getError() !== gl.NO_ERROR) {} // drain, so the check below is this allocation's
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texImage3D(
      gl.TEXTURE_2D_ARRAY, 0, this.float ? gl.RGBA16F : gl.RGBA8, w, h, depth, 0,
      gl.RGBA, this.float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null,
    );
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.framebuffer("draw"));
    gl.framebufferTextureLayer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, 0);
    // The status first, so the error read after it covers the whole allocation,
    // the status check included.
    const complete = gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    const ok = gl.getError() === gl.NO_ERROR && complete;
    // A deleted texture stays alive while a framebuffer that isn't bound holds it.
    if (!ok) gl.framebufferTextureLayer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, null, 0, 0);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    if (ok) return tex;
    gl.deleteTexture(tex);
    return null;
  }

  private copyLayers(from: WebGLTexture, to: WebGLTexture): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.framebuffer("read"));
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.framebuffer("draw"));
    for (const layer of this.layers.values()) {
      gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, from, 0, layer);
      gl.framebufferTextureLayer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, to, 0, layer);
      gl.blitFramebuffer(0, 0, this.w, this.h, 0, 0, this.w, this.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    // The caller deletes `from`, and a deleted texture stays alive while a
    // framebuffer that isn't bound holds it.
    gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, null, 0, 0);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  private ensureStandIn(): WebGLTexture {
    if (this.standIn) return this.standIn;
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.activeTexture(gl.TEXTURE0);
    this.standIn = tex;
    return tex;
  }
}
