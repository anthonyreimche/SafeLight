// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Load-time normalization of persisted masks, focused on what the per-mask
// panel-instance change added: sub-panel ids became registered panel ids (with
// legacy short names migrated), and masks carry an extension-param bag that
// must survive a round-trip untouched. Run with `npm test`.

import { describe, expect, it } from "vitest";
import { normalizeParams, LEGACY_MASK_PANELS, type Mask } from "./types";

// A minimal persisted mask; fields omitted where normalization fills defaults.
function rawMask(over: Partial<Mask>): Partial<Mask> {
  return {
    id: "m1",
    components: [
      {
        id: "c1",
        kind: "lumRange",
        mode: "add",
        invert: false,
        lumRange: { lo: 0, hi: 1, loFeather: 0.1, hiFeather: 0.1 },
      },
    ],
    ...over,
  };
}

function normalizeMask(over: Partial<Mask>): Mask {
  return normalizeParams({ masks: [rawMask(over)] as Mask[] }).masks[0];
}

describe("mask sub-panel id normalization", () => {
  it("maps legacy short names onto registered panel ids", () => {
    const m = normalizeMask({
      panels: ["basic", "wb", "hsl", "curve", "detail"] as string[],
    });
    expect(m.panels).toEqual([
      "core.basic",
      "core.white-balance",
      "core.hsl",
      "core.tone-curve",
      "core.detail",
    ]);
  });

  it("passes registered ids through and dedupes against their legacy alias", () => {
    const m = normalizeMask({ panels: ["core.basic", "basic", "core.hsl"] });
    expect(m.panels).toEqual(["core.basic", "core.hsl"]);
  });

  it("preserves unknown ids (extension disabled) and drops non-strings", () => {
    const m = normalizeMask({
      panels: ["my-ext.grade", 7, null, "core.basic"] as unknown as string[],
    });
    expect(m.panels).toEqual(["my-ext.grade", "core.basic"]);
  });

  it("falls back to the legacy every-slider view when panels are missing", () => {
    const m = normalizeMask({});
    expect(m.panels).toEqual(LEGACY_MASK_PANELS);
  });
});

describe("mask extension-param bag", () => {
  it("survives a normalize round-trip verbatim", () => {
    const bag = { "my-ext.stage.amount": 40, "my-ext.stage.enabled": true };
    expect(normalizeMask({ bag }).bag).toEqual(bag);
  });

  it("is omitted when empty or not an object", () => {
    expect(normalizeMask({ bag: {} }).bag).toBeUndefined();
    expect(normalizeMask({ bag: [1] as unknown as Record<string, unknown> }).bag).toBeUndefined();
  });
});
