// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// 16-bit RGB PNG writer for export. canvas.toBlob only encodes 8-bit PNG, so
// like the TIFF writer this hand-rolls the container, keeping the develop
// pipeline's extra precision. Input is the same top-down RGBA16 layout
// encodeTiff takes at 16 bits; alpha is dropped.

import { iccpChunk, pngChunk } from "@/rendering/color-space";

// Chunk and band buffers are plain ArrayBuffer-backed, which BlobPart and
// CompressionStream (BufferSource) require; the unparameterised Uint8Array
// widens to ArrayBufferLike and no longer fits either.
type Bytes = Uint8Array<ArrayBuffer>;

const SIGNATURE: Bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const SAMPLES = 3; // RGB
const BYTES_PER_SAMPLE = 2;
const FILTER_NONE = 0;
const FILTER_UP = 2;

// Scanlines go to the compressor in bands, so the filtered image (144 MB at
// 24 MP) is never held whole alongside the RGBA source.
const BAND_BYTES = 1 << 20;

function ihdr(width: number, height: number): Bytes {
  const data = new Uint8Array(13);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  data[8] = 16; // bit depth
  data[9] = 2; // colour type: truecolour (RGB)
  // compression, filter and interlace methods stay 0
  return pngChunk("IHDR", data);
}

// The event loop's next task: a message, since browsers hold a nested 0 ms
// timer to 4 ms. The port is closed on delivery, which always comes: an open
// one keeps Node's event loop alive.
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(null);
  });
}

// Filtered scanlines, a band of rows at a time. Up works on bytes, not
// samples (PNG spec): each byte of a 16-bit sample minus the byte above it,
// mod 256, which a Uint8Array store does by itself. The first row has nothing
// above it and is written as None, so its "up" sample is 0.
//
// An export encodes on the main thread and Chromium's CompressionStream
// doesn't yield, so each band waits a task first; otherwise a 24 MP encode
// holds off input and repaints for its whole ~2 s.
function scanlineBands(rgba: Uint16Array, width: number, height: number): ReadableStream<Bytes> {
  const stride = width * 4;
  const lineBytes = 1 + width * SAMPLES * BYTES_PER_SAMPLE;
  const rowsPerBand = Math.max(1, Math.floor(BAND_BYTES / lineBytes));
  let y = 0;
  return new ReadableStream<Bytes>({
    async pull(controller) {
      if (y >= height) {
        controller.close();
        return;
      }
      await nextTask();
      const rows = Math.min(rowsPerBand, height - y);
      const band = new Uint8Array(rows * lineBytes);
      let o = 0;
      for (let r = 0; r < rows; r++, y++) {
        band[o++] = y === 0 ? FILTER_NONE : FILTER_UP;
        for (let x = 0, s = y * stride; x < width; x++, s += 4) {
          for (let c = 0; c < SAMPLES; c++) {
            const v = rgba[s + c];
            const up = y === 0 ? 0 : rgba[s + c - stride];
            band[o++] = (v >> 8) - (up >> 8);
            band[o++] = (v & 0xff) - (up & 0xff);
          }
        }
      }
      controller.enqueue(band);
    },
  });
}

export async function encodePng16(
  rgba: Uint16Array,
  width: number,
  height: number,
  opts: { icc?: Uint8Array },
): Promise<Blob> {
  const deflated = new Response(scanlineBands(rgba, width, height).pipeThrough(new CompressionStream("deflate")));
  const idat = pngChunk("IDAT", new Uint8Array(await deflated.arrayBuffer()));
  return new Blob(
    [
      SIGNATURE,
      ihdr(width, height),
      ...(opts.icc ? [iccpChunk(opts.icc)] : []),
      idat,
      pngChunk("IEND", new Uint8Array(0)),
    ],
    { type: "image/png" },
  );
}
