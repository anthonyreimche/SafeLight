// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The patched copy of the source: the retouch baked in, mipmapped, and sampled
// as uImage by a retouched frame's develop draws. Sized to the (capped) source;
// lazily created on first heal.

import { SCRATCH_UNIT, allocateInto, drainErrors, type Caps, type TexFormat } from "./gl-resources";
import type { ShaderVariant } from "./shaders";
import { developedFormatFor, type DevelopedFormat } from "./variant-decisions";

export class PatchedSource {
  private readonly gl: WebGL2RenderingContext;
  private readonly storage: Record<DevelopedFormat, TexFormat>;
  // What the copy now holds when it loses range, or null when it keeps all of it.
  private readonly report: (note: string | null) => void;
  private tex: WebGLTexture | null = null;
  private fbo: WebGLFramebuffer | null = null;
  private w = 0;
  private h = 0;
  // The format the copy is allocated in: the one the photo's process version
  // wants, or a fallback when that target isn't framebuffer-complete or can't be
  // mipmapped.
  private allocated: DevelopedFormat = "rgba8";
  // Whether the current norm16 or float16 allocation has mipmapped without a GL error.
  private mipsVerified = false;
  // The formats the copy may still take above RGBA8. norm16: a normalized,
  // GPU-mipmappable RGBA16 texture (EXT_texture_norm16, Caps.norm16). float16:
  // a version 2 photo's RGBA16F, which float colour buffers make renderable, and
  // so mipmappable. Each holds until this driver fails to complete or mipmap a
  // full-size one.
  private readonly formats: { float16: boolean; norm16: boolean };

  constructor(gl: WebGL2RenderingContext, caps: Caps, report: (note: string | null) => void) {
    this.gl = gl;
    this.report = report;
    this.formats = { float16: caps.colorBufferFloat, norm16: caps.norm16 !== 0 };
    this.storage = {
      float16: { internalFormat: gl.RGBA16F, type: gl.HALF_FLOAT },
      norm16: { internalFormat: caps.norm16, type: gl.UNSIGNED_SHORT },
      rgba8: { internalFormat: gl.RGBA, type: gl.UNSIGNED_BYTE },
    };
  }

  /** The copy, once bake() has made one. */
  get texture(): WebGLTexture | null {
    return this.tex;
  }

  /** The format the copy is held in. */
  get format(): DevelopedFormat {
    return this.allocated;
  }

  /** Pass 1 of a retouched frame: the w×h copy `variant` wants, with `drawPatch`
   *  drawing the retouch into it, then its mip chain so the develop's blur taps
   *  read the patched pixels. `drawPatch` draws into the bound framebuffer and
   *  leaves TEXTURE0 active. False when no patched copy could be made, so the
   *  caller falls back to the in-shader retouch. */
  bake(w: number, h: number, variant: ShaderVariant, drawPatch: () => void): boolean {
    if (!this.prepare(w, h, variant)) return false;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.w, this.h);
    drawPatch();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    // getError stalls the pipeline, so it runs only for the first mipmap after
    // each 16-bit (re)allocation rather than on every retouched frame.
    const verify = this.allocated !== "rgba8" && !this.mipsVerified;
    if (verify) drainErrors(gl);
    gl.generateMipmap(gl.TEXTURE_2D);
    if (!verify) return true;
    if (gl.getError() === gl.NO_ERROR) {
      this.mipsVerified = true;
      return true;
    }
    // The 2x2 constructor probe passed (norm16), or float colour buffers made
    // RGBA16F renderable, but this driver fails generateMipmap on the full-size
    // target (0x0502). An incomplete mip chain samples as black, so abandon that
    // format for this renderer and re-bake this frame's copy into the next one
    // down.
    drainErrors(gl);
    if (this.allocated === "float16") this.formats.float16 = false;
    else this.formats.norm16 = false;
    return this.bake(w, h, variant, drawPatch);
  }

  // Create / resize the copy. Returns false if the framebuffer can't be
  // completed, so the caller falls back.
  private prepare(w: number, h: number, variant: ShaderVariant): boolean {
    const gl = this.gl;
    const tex = (this.tex ??= gl.createTexture());
    const fbo = (this.fbo ??= gl.createFramebuffer());
    // An RGBA8 patched-source copy quantises a 16-bit/float linear source to 8 bits,
    // so any heal spot bands smooth gradients. RGBA16 (norm16) is colour-renderable,
    // filterable AND GPU-mipmappable, so it removes the banding while keeping the
    // per-frame generateMipmap and the same linear/[0,1] semantics. RGBA16F is all
    // three once float colour buffers are renderable, and it also keeps the headroom
    // and the channels below black: the copy a version 2 photo develops from.
    // Version 1 photos keep the clipped copy their edits were made with.
    const wanted = developedFormatFor(variant, this.formats);
    if (this.w === w && this.h === h && this.allocated === wanted) return true;
    // Try the wanted format first; if its target isn't framebuffer-complete on
    // this device, step down to norm16, then RGBA8, rather than fail.
    const alloc = (format: DevelopedFormat): boolean => {
      // On the scratch unit, and let go of afterwards: the unit active here can
      // be one a sampler reads (render() leaves 4 active), and a unit holding the
      // copy while the patch pass draws into it is a feedback loop for any
      // sampler that reads that unit.
      gl.activeTexture(gl.TEXTURE0 + SCRATCH_UNIT);
      const complete = allocateInto(gl, tex, fbo, this.storage[format], w, h, gl.LINEAR, gl.LINEAR_MIPMAP_LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, null);
      // A format the driver won't complete stays refused, so later frames
      // don't reallocate and ask again.
      if (!complete && format !== "rgba8") this.formats[format] = false;
      return complete;
    };
    const formats: DevelopedFormat[] = [wanted];
    if (wanted === "float16" && this.formats.norm16) formats.push("norm16");
    if (wanted !== "rgba8") formats.push("rgba8");
    const format = formats.find(alloc);
    if (!format) {
      this.w = 0;
      this.h = 0;
      return false;
    }
    this.report(
      variant.fullInfo && format !== "float16"
        ? `Heal and clone develop from a ${format === "norm16" ? "16-bit" : "8-bit"} copy of the image, ` +
            "clipped to 0–1, so values above white and below black are lost."
        : null,
    );
    this.allocated = format;
    this.mipsVerified = false;
    this.w = w;
    this.h = h;
    return true;
  }

  dispose(): void {
    if (this.tex) this.gl.deleteTexture(this.tex);
    if (this.fbo) this.gl.deleteFramebuffer(this.fbo);
    this.tex = null;
    this.fbo = null;
  }
}
