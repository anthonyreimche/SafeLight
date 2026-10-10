// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A minimal zip reader for extension release assets: stored and deflated
// entries in a single-disk archive, which is what GitHub Actions, `zip -r` and
// Explorer's compressed folders produce. Returns the same { name, data } list as
// main.cjs's untar, so both feed one set of install checks. Anything else is
// refused rather than half-read.

"use strict";

const zlib = require("node:zlib");

const END = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const ZIP64_LOCATOR = 0x07064b50;
const MAX_UNPACKED = 256 * 1024 * 1024;

const zip64 = () => new Error("zip64 archives are not supported");
const corrupt = (where) => new Error(`corrupt zip (${where})`);

/** Offset of the end-of-central-directory record, or -1. */
function findEnd(buf) {
  const stop = Math.max(0, buf.length - (0xffff + 22));
  for (let i = buf.length - 22; i >= stop; i--) if (buf.readUInt32LE(i) === END) return i;
  return -1;
}

/** The archive's files as { name, data }, directories skipped. */
function unzip(buf, { maxUnpacked = MAX_UNPACKED } = {}) {
  const end = findEnd(buf);
  if (end < 0) throw new Error("not a zip archive");
  if (end >= 20 && buf.readUInt32LE(end - 20) === ZIP64_LOCATOR) throw zip64();
  const count = buf.readUInt16LE(end + 10);
  const size = buf.readUInt32LE(end + 12);
  const offset = buf.readUInt32LE(end + 16);
  if (
    buf.readUInt16LE(end + 4) !== 0 ||
    buf.readUInt16LE(end + 6) !== 0 ||
    buf.readUInt16LE(end + 8) !== count
  )
    throw new Error("multi-disk archives are not supported");
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw zip64();
  if (offset + size > end) throw corrupt("central directory");

  const files = [];
  let unpacked = 0;
  let p = offset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || buf.readUInt32LE(p) !== CENTRAL) throw corrupt("central directory");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const packed = buf.readUInt32LE(p + 20);
    const length = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? "utf8" : "latin1", p + 46, p + 46 + nameLength);
    p += 46 + nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (packed === 0xffffffff || length === 0xffffffff || local === 0xffffffff) throw zip64();
    if (name.endsWith("/")) continue;
    if (flags & 0x1) throw new Error(`${name}: encrypted entries are not supported`);
    if (method !== 0 && method !== 8)
      throw new Error(`${name}: unsupported compression (method ${method})`);
    unpacked += length;
    if (unpacked > maxUnpacked) throw new Error("archive is too large to install");
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL) throw corrupt(name);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + packed > buf.length) throw corrupt(name);
    const raw = buf.subarray(start, start + packed);
    let data;
    try {
      data =
        method === 0
          ? Buffer.from(raw)
          : zlib.inflateRawSync(raw, { maxOutputLength: Math.max(length, 1) });
    } catch {
      throw corrupt(name);
    }
    if (data.length !== length || zlib.crc32(data) !== crc)
      throw new Error(`${name}: checksum mismatch`);
    files.push({ name, data });
  }
  return files;
}

module.exports = { unzip };
