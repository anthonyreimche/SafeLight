// RAW files (Nikon NEF, etc.) are TIFF-based containers that embed one or more
// JPEG previews. Until full RAW decoding lands (libraw/WASM, Phase 3), we
// extract the largest *decodable* embedded JPEG so RAW files import and display.

const RAW_EXTENSIONS = new Set([
  ".nef",
  ".cr2",
  ".cr3",
  ".arw",
  ".dng",
  ".orf",
  ".raf",
  ".pef",
  ".srw",
  ".rw2",
  ".iiq",
  ".3fr",
  ".nrw",
  ".kdc",
  ".mos",
  ".mrw",
  ".erf",
  ".sr2",
  ".x3f",
  ".srf",
  ".dcr",
  ".rwl",
  ".fff",
  ".gpr",
  ".mef",
  ".crw",
]);

export function getExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

export function isRawFile(file: File): boolean {
  return RAW_EXTENSIONS.has(getExtension(file.name));
}

interface JpegRange {
  start: number;
  end: number;
}

// Scan the byte stream for JPEG segments (SOI `FF D8 FF` … EOI `FF D9`),
// returning their byte ranges sorted largest-first.
function collectJpegs(buf: Uint8Array): JpegRange[] {
  const found: JpegRange[] = [];
  const n = buf.length;
  let i = 0;

  while (i < n - 2) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd8 && buf[i + 2] === 0xff) {
      const start = i;
      let j = i + 3;
      let end = -1;
      while (j < n - 1) {
        if (buf[j] === 0xff && buf[j + 1] === 0xd9) {
          end = j + 2;
          break;
        }
        j++;
      }
      if (end === -1) break;
      found.push({ start, end });
      i = end;
    } else {
      i++;
    }
  }

  return found.sort((a, b) => b.end - b.start - (a.end - a.start));
}

// Return the largest embedded JPEG that the browser can actually decode. The
// largest segment is sometimes the lossless-compressed raw sensor data (SOF3),
// which browsers can't decode — so we test candidates and fall back to the next.
export async function extractRawPreview(file: File): Promise<Blob | null> {
  const arrayBuffer = await file.arrayBuffer();
  const candidates = collectJpegs(new Uint8Array(arrayBuffer));

  for (const { start, end } of candidates) {
    const blob = new Blob([arrayBuffer.slice(start, end)], {
      type: "image/jpeg",
    });
    try {
      const bitmap = await createImageBitmap(blob);
      bitmap.close();
      return blob;
    } catch {
      // Not a decodable baseline JPEG — try the next candidate.
    }
  }

  return null;
}
