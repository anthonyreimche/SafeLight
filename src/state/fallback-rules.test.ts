// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What each kind of loaded image may be: the photo's own pixels and the camera's
// preview of a RAW the decoder can't use stand for the photo; any other preview the
// load fell back on doesn't; the stored preview rendered with the edit is never
// rendered over.

import { describe, expect, it } from "vitest";
import type { DecodedImage, Fallback } from "@/catalog/load-image";
import { isStoredPreview, showsEdit, standsForPhoto } from "./fallback-rules";

const bitmap = { width: 2, height: 2 } as unknown as ImageBitmap;
const NONE = { offline: false, unsupported: false, timedOut: false };
const fellBack = (fallback: Fallback): DecodedImage => ({ kind: "bitmap", bitmap, fallback });

const decoded: DecodedImage = { kind: "float", data: new Float32Array(4), width: 2, height: 2 };
const jpeg: DecodedImage = { kind: "bitmap", bitmap };
const unsupported = fellBack({ from: "embedded", ...NONE, unsupported: true });
const timedOut = fellBack({ from: "embedded", ...NONE, timedOut: true });
const stored = fellBack({ from: "stored", ...NONE, offline: true });
const storedUnsupported = fellBack({ from: "stored", ...NONE, unsupported: true });
const storedEdited = fellBack({ from: "stored-edited", ...NONE, offline: true });

// [what, image, stands for the photo, already the edit, the stored preview]
describe.each([
  ["a full decode", decoded, true, false, false],
  ["a JPEG's own pixels", jpeg, true, false, false],
  ["the camera's preview of a RAW it can't open", unsupported, true, false, false],
  ["the camera's preview after a timeout", timedOut, false, false, false],
  ["the plain stored preview, the original out of reach", stored, false, false, true],
  ["the plain stored preview of a RAW it can't open", storedUnsupported, false, false, true],
  ["the stored preview rendered with the edit", storedEdited, false, true, true],
] as const)("%s", (_what, image, stands, edited, storedPreview) => {
  it(`${stands ? "stands" : "doesn't stand"} for the photo`, () => {
    expect(standsForPhoto(image)).toBe(stands);
  });

  it(`${edited ? "is" : "isn't"} already the edit`, () => {
    expect(showsEdit(image)).toBe(edited);
  });

  it(`${storedPreview ? "is" : "isn't"} the stored preview`, () => {
    expect(isStoredPreview(image)).toBe(storedPreview);
  });
});
