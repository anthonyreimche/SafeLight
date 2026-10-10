// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The release-asset zip reader: what it reads, and everything it refuses
// instead of half-reading. Archives are built here, byte by byte.

import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import { unzip } from "./unzip.cjs";

interface Entry {
  name: string;
  data?: string;
  method?: number;
  flags?: number;
  crc?: number;
}

/** A minimal zip: local headers and data, the central directory, the end record. */
function zip(entries: Entry[], { zip64Locator = false } = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.from(e.data ?? "");
    const method = e.method ?? 8;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = e.crc ?? zlib.crc32(data);
    const flags = e.flags ?? 0x800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(body.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(record, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const locator = Buffer.alloc(zip64Locator ? 20 : 0);
  if (zip64Locator) locator.writeUInt32LE(0x07064b50, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, locator, end]);
}

const text = (files: { name: string; data: Buffer }[]) =>
  files.map((f) => [f.name, f.data.toString("utf8")]);

describe("unzip", () => {
  it("reads stored and deflated entries", () => {
    const files = unzip(
      zip([
        { name: "safelight.json", data: '{"id":"acme.widget"}', method: 8 },
        { name: "dist/index.js", data: "export function activate() {}", method: 0 },
      ]),
    );
    expect(text(files)).toEqual([
      ["safelight.json", '{"id":"acme.widget"}'],
      ["dist/index.js", "export function activate() {}"],
    ]);
  });

  it("skips directory entries", () => {
    const files = unzip(zip([{ name: "dist/", method: 0 }, { name: "dist/a.js", data: "a" }]));
    expect(files.map((f) => f.name)).toEqual(["dist/a.js"]);
  });

  it("refuses encrypted entries", () => {
    expect(() => unzip(zip([{ name: "a.js", data: "a", flags: 0x801 }]))).toThrow(
      "a.js: encrypted entries are not supported",
    );
  });

  it("refuses an unknown compression method", () => {
    expect(() => unzip(zip([{ name: "a.js", data: "a", method: 12 }]))).toThrow(
      "a.js: unsupported compression (method 12)",
    );
  });

  it("refuses a checksum mismatch", () => {
    expect(() => unzip(zip([{ name: "a.js", data: "abc", crc: 1 }]))).toThrow(
      "a.js: checksum mismatch",
    );
  });

  it("refuses zip64 archives", () => {
    expect(() => unzip(zip([{ name: "a.js", data: "a" }], { zip64Locator: true }))).toThrow(
      "zip64 archives are not supported",
    );
  });

  it("refuses an archive that unpacks past the cap", () => {
    expect(() =>
      unzip(zip([{ name: "a.js", data: "0123456789x" }]), { maxUnpacked: 10 }),
    ).toThrow("archive is too large to install");
  });

  it("refuses data that isn't a zip", () => {
    expect(() => unzip(Buffer.from("hello world, not a zip at all"))).toThrow("not a zip archive");
  });
});
