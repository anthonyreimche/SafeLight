// Minimal store-only (no compression) ZIP writer.
//
// We bundle already-compressed image blobs (JPEG/PNG/WebP); running DEFLATE over
// them would burn CPU for essentially no size win, so "stored" entries are the
// right call here — and it keeps the writer small and dependency-free, in line
// with the project's no-vendored-packages rule.
//
// Layout (all multi-byte fields little-endian):
//   [local header + name + data] * n
//   [central directory header + name] * n
//   [end of central directory]

interface ZipEntry {
  nameBytes: Uint8Array;
  crc: number;
  size: number;
  offset: number; // byte offset of this entry's local header
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// MS-DOS date/time, the only timestamp format the ZIP local/central records use.
function dosDateTime(d: Date): { time: number; date: number } {
  const time =
    (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date =
    ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export class ZipWriter {
  // Typed as <ArrayBuffer> (not the default <ArrayBufferLike>) so the array is
  // assignable to BlobPart[] under TS 5.7+, which rejects SharedArrayBuffer-
  // backed views.
  private chunks: Uint8Array<ArrayBuffer>[] = [];
  private entries: ZipEntry[] = [];
  private offset = 0;
  private dt = dosDateTime(new Date());
  private encoder = new TextEncoder();

  // Add one file. `data` is taken as-is (already-encoded image bytes).
  add(name: string, data: Uint8Array<ArrayBuffer>): void {
    const nameBytes = this.encoder.encode(name);
    const crc = crc32(data);

    const header = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); // local file header signature
    view.setUint16(4, 20, true); // version needed to extract (2.0)
    view.setUint16(6, 0, true); // general purpose flags
    view.setUint16(8, 0, true); // compression method: 0 = stored
    view.setUint16(10, this.dt.time, true);
    view.setUint16(12, this.dt.date, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, data.length, true); // compressed size == size (stored)
    view.setUint32(22, data.length, true); // uncompressed size
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true); // extra field length
    header.set(nameBytes, 30);

    this.entries.push({ nameBytes, crc, size: data.length, offset: this.offset });
    this.chunks.push(header, data);
    this.offset += header.length + data.length;
  }

  // Serialize everything added so far into a single application/zip Blob.
  blob(): Blob {
    const cdChunks: Uint8Array<ArrayBuffer>[] = [];
    let cdSize = 0;
    const cdStart = this.offset;

    for (const e of this.entries) {
      const h = new Uint8Array(46 + e.nameBytes.length);
      const v = new DataView(h.buffer);
      v.setUint32(0, 0x02014b50, true); // central directory header signature
      v.setUint16(4, 20, true); // version made by
      v.setUint16(6, 20, true); // version needed to extract
      v.setUint16(8, 0, true); // flags
      v.setUint16(10, 0, true); // compression method: stored
      v.setUint16(12, this.dt.time, true);
      v.setUint16(14, this.dt.date, true);
      v.setUint32(16, e.crc, true);
      v.setUint32(20, e.size, true); // compressed size
      v.setUint32(24, e.size, true); // uncompressed size
      v.setUint16(28, e.nameBytes.length, true);
      v.setUint16(30, 0, true); // extra field length
      v.setUint16(32, 0, true); // comment length
      v.setUint16(34, 0, true); // disk number start
      v.setUint16(36, 0, true); // internal attributes
      v.setUint32(38, 0, true); // external attributes
      v.setUint32(42, e.offset, true); // local header offset
      h.set(e.nameBytes, 46);
      cdChunks.push(h);
      cdSize += h.length;
    }

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); // end of central directory signature
    ev.setUint16(4, 0, true); // this disk number
    ev.setUint16(6, 0, true); // disk with central directory
    ev.setUint16(8, this.entries.length, true); // entries on this disk
    ev.setUint16(10, this.entries.length, true); // total entries
    ev.setUint32(12, cdSize, true); // central directory size
    ev.setUint32(16, cdStart, true); // central directory offset
    ev.setUint16(20, 0, true); // comment length

    return new Blob([...this.chunks, ...cdChunks, eocd], {
      type: "application/zip",
    });
  }
}
