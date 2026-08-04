// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Byte-level tests for the store-only ZIP writer. There is no unzip dependency,
// so the archive is walked the way a real extractor does: end-of-central-
// directory record -> central directory -> each entry's local header.

import { describe, it, expect } from "vitest";
import { ZipWriter } from "./zip";

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const FLAG_UTF8 = 0x0800;
const EOCD_SIZE = 22;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;

type Bytes = Uint8Array<ArrayBuffer>;

const u16 = (b: Bytes, at: number): number => b[at] | (b[at + 1] << 8);
const u32 = (b: Bytes, at: number): number =>
  (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const utf8 = (text: string): Bytes => new TextEncoder().encode(text);
const decode = (b: Bytes, at: number, len: number): string =>
  new TextDecoder().decode(b.subarray(at, at + len));

async function archive(...files: Array<[string, Bytes]>): Promise<Bytes> {
  const zip = new ZipWriter();
  for (const [name, data] of files) zip.add(name, data);
  return new Uint8Array(await zip.blob().arrayBuffer());
}

interface CentralEntry {
  name: string;
  crc: number;
  size: number;
  flags: number;
  method: number;
  localOffset: number;
}

function eocdAt(zip: Bytes): number {
  return zip.length - EOCD_SIZE;
}

function centralDirectory(zip: Bytes): CentralEntry[] {
  const eocd = eocdAt(zip);
  const total = u16(zip, eocd + 10);
  const entries: CentralEntry[] = [];
  let p = u32(zip, eocd + 16);
  for (let i = 0; i < total; i++) {
    const nameLen = u16(zip, p + 28);
    const extraLen = u16(zip, p + 30);
    const commentLen = u16(zip, p + 32);
    entries.push({
      name: decode(zip, p + CENTRAL_HEADER_SIZE, nameLen),
      flags: u16(zip, p + 8),
      method: u16(zip, p + 10),
      crc: u32(zip, p + 16),
      size: u32(zip, p + 24),
      localOffset: u32(zip, p + 42),
    });
    p += CENTRAL_HEADER_SIZE + nameLen + extraLen + commentLen;
  }
  return entries;
}

// Follow a central-directory entry to its local header and pull out the payload.
function payload(zip: Bytes, entry: CentralEntry): Bytes {
  const local = entry.localOffset;
  const start = local + LOCAL_HEADER_SIZE + u16(zip, local + 26) + u16(zip, local + 28);
  return zip.slice(start, start + entry.size);
}

describe("ZipWriter structure", () => {
  it("writes a bare end-of-central-directory record for an empty archive", async () => {
    const zip = await archive();

    expect(zip).toHaveLength(EOCD_SIZE);
    expect(u32(zip, 0)).toBe(EOCD_SIG);
    expect(u16(zip, 8)).toBe(0); // entries on this disk
    expect(u16(zip, 10)).toBe(0); // total entries
    expect(u32(zip, 12)).toBe(0); // central directory size
    expect(u32(zip, 16)).toBe(0); // central directory offset
  });

  it("writes a stored local file header followed by the raw payload", async () => {
    const data = utf8("hello");
    const zip = await archive(["a.jpg", data]);

    expect(u32(zip, 0)).toBe(LOCAL_SIG);
    expect(u16(zip, 4)).toBe(20); // version needed to extract
    expect(u16(zip, 6)).toBe(0); // no general-purpose flags for an ASCII name
    expect(u16(zip, 8)).toBe(0); // method 0 = stored
    expect(u32(zip, 18)).toBe(data.length); // compressed size
    expect(u32(zip, 22)).toBe(data.length); // uncompressed size
    expect(u16(zip, 26)).toBe(5); // file name length
    expect(u16(zip, 28)).toBe(0); // extra field length
    expect(decode(zip, LOCAL_HEADER_SIZE, 5)).toBe("a.jpg");
    expect(Array.from(zip.subarray(LOCAL_HEADER_SIZE + 5, LOCAL_HEADER_SIZE + 5 + data.length)))
      .toEqual(Array.from(data));
  });

  it("computes the standard CRC-32 check value", async () => {
    // The IEEE CRC-32 of "123456789" is 0xCBF43926, the canonical check value.
    const zip = await archive(["check.bin", utf8("123456789")]);

    expect(u32(zip, 14)).toBe(0xcbf43926);
    expect(centralDirectory(zip)[0].crc).toBe(0xcbf43926);
  });

  it("mirrors each local header in the central directory", async () => {
    const data = utf8("payload bytes");
    const zip = await archive(["shot.jpg", data]);
    const cdStart = LOCAL_HEADER_SIZE + 8 + data.length;

    expect(u32(zip, cdStart)).toBe(CENTRAL_SIG);
    expect(u16(zip, cdStart + 4)).toBe(20); // version made by
    expect(u16(zip, cdStart + 6)).toBe(20); // version needed to extract
    expect(u16(zip, cdStart + 10)).toBe(0); // stored
    expect(u32(zip, cdStart + 16)).toBe(u32(zip, 14)); // crc
    expect(u32(zip, cdStart + 20)).toBe(data.length);
    expect(u32(zip, cdStart + 24)).toBe(data.length);
    expect(u16(zip, cdStart + 30)).toBe(0); // extra field length
    expect(u16(zip, cdStart + 32)).toBe(0); // comment length
    expect(u16(zip, cdStart + 34)).toBe(0); // disk number start
    expect(u16(zip, cdStart + 36)).toBe(0); // internal attributes
    expect(u32(zip, cdStart + 38)).toBe(0); // external attributes
    expect(u32(zip, cdStart + 42)).toBe(0); // local header offset
    expect(decode(zip, cdStart + CENTRAL_HEADER_SIZE, 8)).toBe("shot.jpg");
  });

  it("records the entry count and central-directory extent in the EOCD", async () => {
    const zip = await archive(["a", utf8("aa")], ["bb", utf8("bbbb")]);
    const eocd = eocdAt(zip);
    const cdStart = u32(zip, eocd + 16);
    const cdSize = u32(zip, eocd + 12);

    expect(u16(zip, eocd + 8)).toBe(2);
    expect(u16(zip, eocd + 10)).toBe(2);
    expect(u16(zip, eocd + 20)).toBe(0); // archive comment length
    // Local records first, then the two central headers, then the EOCD.
    expect(cdStart).toBe(LOCAL_HEADER_SIZE + 1 + 2 + LOCAL_HEADER_SIZE + 2 + 4);
    expect(cdSize).toBe(CENTRAL_HEADER_SIZE + 1 + CENTRAL_HEADER_SIZE + 2);
    expect(cdStart + cdSize).toBe(eocd);
    expect(u32(zip, cdStart)).toBe(CENTRAL_SIG);
  });

  it("chains local header offsets across entries", async () => {
    const first = utf8("first payload");
    const zip = await archive(["one.jpg", first], ["two.jpg", utf8("second")]);
    const entries = centralDirectory(zip);

    expect(entries.map((e) => e.localOffset)).toEqual([
      0,
      LOCAL_HEADER_SIZE + 7 + first.length,
    ]);
    expect(u32(zip, entries[1].localOffset)).toBe(LOCAL_SIG);
  });
});

describe("ZipWriter round trip", () => {
  it("recovers every name and payload through a central-directory walk", async () => {
    const files: Array<[string, Bytes]> = [
      ["one.jpg", utf8("first")],
      ["nested/two.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])],
      ["empty.bin", new Uint8Array(0)],
    ];
    const zip = await archive(...files);
    const entries = centralDirectory(zip);

    expect(entries.map((e) => e.name)).toEqual(files.map(([name]) => name));
    entries.forEach((entry, i) => {
      expect(entry.method).toBe(0);
      expect(entry.size).toBe(files[i][1].length);
      expect(Array.from(payload(zip, entry))).toEqual(Array.from(files[i][1]));
      expect(u32(zip, entry.localOffset)).toBe(LOCAL_SIG);
    });
  });

  it("stores an empty file with a zero CRC and no payload bytes", async () => {
    const zip = await archive(["empty.bin", new Uint8Array(0)]);

    expect(u32(zip, 14)).toBe(0);
    expect(u32(zip, 18)).toBe(0);
    expect(zip).toHaveLength(
      LOCAL_HEADER_SIZE + 9 + CENTRAL_HEADER_SIZE + 9 + EOCD_SIZE,
    );
  });
});

describe("ZipWriter file names", () => {
  it("encodes non-ASCII names as UTF-8 and sets the EFS flag", async () => {
    const name = "café/写真.jpg";
    const nameBytes = utf8(name);
    const zip = await archive([name, utf8("x")]);
    const entry = centralDirectory(zip)[0];

    expect(nameBytes.length).toBeGreaterThan(name.length); // multi-byte, as intended
    expect(u16(zip, 26)).toBe(nameBytes.length);
    expect(u16(zip, 6) & FLAG_UTF8).toBe(FLAG_UTF8);
    expect(entry.flags & FLAG_UTF8).toBe(FLAG_UTF8);
    expect(entry.name).toBe(name);
  });

  it("leaves the EFS flag clear for names that are pure ASCII", async () => {
    const zip = await archive(["plain-name_1.jpg", utf8("x")]);

    expect(u16(zip, 6)).toBe(0);
    expect(centralDirectory(zip)[0].flags).toBe(0);
  });
});

describe("ZipWriter timestamps and limits", () => {
  it("stamps the current date as MS-DOS time in both headers", async () => {
    const now = new Date();
    const zip = await archive(["a.jpg", utf8("x")]);
    const cdStart = LOCAL_HEADER_SIZE + 5 + 1;
    const date = u16(zip, 12);

    expect((date >>> 9) + 1980).toBe(now.getFullYear());
    expect((date >>> 5) & 0x0f).toBe(now.getMonth() + 1);
    expect(date & 0x1f).toBe(now.getDate());
    // The central header repeats the same time/date pair.
    expect(u16(zip, cdStart + 12)).toBe(u16(zip, 10));
    expect(u16(zip, cdStart + 14)).toBe(date);
  });

  it("refuses to exceed the ZIP32 65535-entry limit", () => {
    const zip = new ZipWriter();
    const empty = new Uint8Array(0);
    for (let i = 0; i < 0xffff; i++) zip.add("f", empty);

    expect(() => zip.add("f", empty)).toThrow(RangeError);
  });
});
