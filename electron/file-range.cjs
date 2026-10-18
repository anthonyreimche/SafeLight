// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The main-process half of a ranged fs.read. The import needs a RAW's head and
// camera preview, a few MB at its start, and a whole-file read of a 25 MB RAW
// off a spinning disk costs ten times as long. main.cjs owns the IPC; this
// module runs against temp folders in tests.

const fsp = require("node:fs/promises");

/** Bytes [start, end) of the file at `p`, clipped to its end, with the whole
 *  file's size and mtime. A range that isn't two whole numbers with
 *  0 <= start <= end is refused before the file is opened. */
async function readFileRange(p, start, end) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start)
    throw new RangeError(`Invalid byte range ${start}-${end}`);
  const fh = await fsp.open(p, "r");
  try {
    const { size, mtimeMs } = await fh.stat();
    const from = Math.min(start, size);
    const data = Buffer.allocUnsafe(Math.min(end, size) - from);
    let filled = 0;
    while (filled < data.length) {
      const { bytesRead } = await fh.read(data, filled, data.length - filled, from + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return { data: data.subarray(0, filled), mtimeMs, size };
  } finally {
    await fh.close();
  }
}

module.exports = { readFileRange };
