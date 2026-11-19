// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// libheif-js's ES module bundle (the wasm inlined) ships no declaration of
// its own; this covers the calls heif-decode.ts makes. Embind enums are
// objects whose `value` is the C enum's number.
declare module "libheif-js/libheif-wasm/libheif-bundle.mjs" {
  export interface HeifEnum {
    value: number;
  }

  export interface HeifError {
    code: HeifEnum;
    subcode: HeifEnum;
    message: string;
  }

  export interface HeifContext {
    delete(): void;
  }

  export interface HeifImageHandle {
    delete(): void;
  }

  export interface HeifImage {
    delete(): void;
  }

  export interface HeifChannel {
    id: HeifEnum;
    width: number;
    height: number;
    /** Bytes per row. */
    stride: number;
    bits_per_pixel: number;
    /** A view into the module's heap, valid until the image is released. */
    data: Uint8Array;
  }

  export interface HeifDecodedImage {
    image: HeifImage;
    width: number;
    height: number;
    channels: HeifChannel[];
  }

  export interface LibHeif {
    heif_colorspace: { heif_colorspace_RGB: HeifEnum };
    heif_chroma: { heif_chroma_interleaved_RRGGBB_LE: HeifEnum };
    heif_context_alloc(): HeifContext;
    heif_context_read_from_memory(context: HeifContext, bytes: Uint8Array): HeifError;
    heif_js_context_get_primary_image_handle(context: HeifContext): HeifImageHandle | HeifError;
    heif_image_handle_get_width(handle: HeifImageHandle): number;
    heif_image_handle_get_height(handle: HeifImageHandle): number;
    heif_js_decode_image2(
      handle: HeifImageHandle,
      colourspace: HeifEnum,
      chroma: HeifEnum,
    ): HeifDecodedImage | HeifError;
    heif_image_release(image: HeifImage): void;
    heif_image_handle_release(handle: HeifImageHandle): void;
    heif_context_free(context: HeifContext): void;
  }

  export default function libheif(options?: { wasmBinary?: ArrayBuffer }): LibHeif;
}
