// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, it, expect } from "vitest";
import { findJpegEnd } from "./raw-preview";

// Helper: assemble bytes from a flat list of numbers.
const bytes = (...b: number[]) => new Uint8Array(b);

describe("findJpegEnd", () => {
  it("returns the end of a minimal baseline JPEG", () => {
    // SOI | SOS len=2 | entropy 11 22 | EOI
    const buf = bytes(0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9);
    expect(findJpegEnd(buf, 0)).toBe(buf.length);
  });

  it("skips a nested EXIF thumbnail and returns the OUTER EOI", () => {
    // The bug this guards against: a naive FF-D9 search stops at the inner
    // thumbnail's EOI (index 10) and truncates the preview. The marker walk must
    // skip the APP1 segment (incl. its nested SOI…EOI) and return the outer EOI.
    const buf = bytes(
      0xff, 0xd8,                          // outer SOI
      0xff, 0xe1, 0x00, 0x06, 0xff, 0xd8, 0xff, 0xd9, // APP1 len=6 w/ nested SOI+EOI
      0xff, 0xda, 0x00, 0x02,              // SOS
      0x11, 0x22,                          // entropy data
      0xff, 0xd9,                          // outer EOI
    );
    const innerEoi = 10; // where the naive scan would have stopped
    const end = findJpegEnd(buf, 0);
    expect(end).toBe(buf.length);
    expect(end).toBeGreaterThan(innerEoi);
  });

  it("treats FF00 stuffing and restart markers as entropy, not EOI", () => {
    // SOS entropy containing a stuffed FF00 and a restart marker FF D0.
    const buf = bytes(
      0xff, 0xd8,
      0xff, 0xda, 0x00, 0x02,
      0x11, 0xff, 0x00, 0x22, 0xff, 0xd0, 0x33, // FF00 stuffing + RST0
      0xff, 0xd9,
    );
    expect(findJpegEnd(buf, 0)).toBe(buf.length);
  });

  it("returns -1 for a truncated stream with no EOI", () => {
    const buf = bytes(0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22);
    expect(findJpegEnd(buf, 0)).toBe(-1);
  });
});
