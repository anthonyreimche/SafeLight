// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A split is redrawn only when something upstream of its cut changed.
// Dragging the stage's own inline params, anything downstream, or the crop
// must reuse it; anything that feeds the cut must not.

import { describe, expect, it, vi } from "vitest";
import {
  defaultMaskAdjustments,
  freshParams,
  type DevelopParams,
  type Mask,
  type RetouchSpot,
} from "@/catalog/types";
import type { SplitCut, StageSplit } from "./stage-injection";
import {
  SplitTokens,
  splitUpstreamKey,
  type SplitSources,
  type SplitUpstreamInputs,
} from "./split-signature";

const inputs = (over: Partial<SplitUpstreamInputs> = {}): SplitUpstreamInputs => ({
  params: freshParams(5000),
  cut: "scene",
  bag: { "up.stage.amount": 1, "own.stage.take": 1, "down.stage.amount": 1 },
  upstreamStageIds: ["up.stage"],
  textureVersions: { "up.stage.lut": 1, "down.stage.lut": 1 },
  context: "ctx",
  ...over,
});
const key = (over: Partial<SplitUpstreamInputs> = {}) => splitUpstreamKey(inputs(over));
const withParams = (p: Partial<DevelopParams>, cut: SplitCut = "scene") =>
  key({ params: { ...freshParams(5000), ...p }, cut });

const MASK: Mask = {
  id: "m",
  name: "Mask",
  visible: true,
  invert: false,
  opacity: 100,
  adj: defaultMaskAdjustments(),
  panels: [],
  components: [],
};

const SPOT: RetouchSpot = {
  id: "s",
  shape: "circle",
  mode: "heal",
  visible: true,
  dstX: 0.5,
  dstY: 0.5,
  srcX: 0.25,
  srcY: 0.25,
  radius: 0.1,
  feather: 0,
  opacity: 100,
};

describe("splitUpstreamKey", () => {
  it("changes with what feeds a scene cut", () => {
    const upstream: Partial<DevelopParams>[] = [
      { exposure: 1 },
      { temperature: 4000 },
      { highlights: -30 },
      { colorNR: 40 },
      { processVersion: 1 },
    ];
    for (const p of upstream) expect(withParams(p)).not.toBe(key());
  });

  it("ignores display tools for a scene cut but not for a display cut", () => {
    const display: Partial<DevelopParams>[] = [
      { contrast: 30 },
      { saturation: 10 },
      { sharpening: 60 },
      { clarity: 20 },
    ];
    for (const p of display) {
      expect(withParams(p)).toBe(key());
      expect(withParams(p, "display")).not.toBe(key({ cut: "display" }));
    }
  });

  it("never depends on the crop, geometry or output-frame effects", () => {
    const base = freshParams(5000);
    const outside: Partial<DevelopParams>[] = [
      { crop: { x: 0.1, y: 0, width: 0.5, height: 1 } },
      { straighten: 3 },
      { vignette: { ...base.vignette, amount: -40 } },
      { grain: { ...base.grain, amount: 30 } },
    ];
    for (const p of outside)
      for (const cut of ["scene", "display"] as const)
        expect(withParams(p, cut)).toBe(key({ cut }));
  });

  it("follows upstream stages' params and textures, not its own or downstream ones", () => {
    const bag = inputs().bag;
    expect(key({ bag: { ...bag, "up.stage.amount": 2 } })).not.toBe(key());
    expect(key({ textureVersions: { "up.stage.lut": 2, "down.stage.lut": 1 } })).not.toBe(key());
    expect(key({ bag: { ...bag, "own.stage.take": 0 } })).toBe(key());
    expect(key({ bag: { ...bag, "down.stage.amount": 9 } })).toBe(key());
    expect(key({ textureVersions: { "up.stage.lut": 1, "down.stage.lut": 7 } })).toBe(key());
  });

  it("ignores a mask's display adjustments for a scene cut", () => {
    const withMask = (adj: Partial<Mask["adj"]>) =>
      key({ params: { ...freshParams(5000), masks: [{ ...MASK, adj: { ...MASK.adj, ...adj } }] } });
    expect(withMask({ contrast: 30 })).toBe(withMask({}));
    expect(withMask({ exposure: 1 })).not.toBe(withMask({}));
  });

  it("changes with the renderer context", () => {
    expect(key({ context: "other" })).not.toBe(key());
  });

  // A decode cut sits ahead of core noise reduction, white balance, exposure
  // and the masks, and ahead of everything the renderer context describes.
  it("keys a decode cut on the upstream stages and the retouch only", () => {
    const decode = key({ cut: "decode" });
    const core: Partial<DevelopParams>[] = [
      { exposure: 1 },
      { temperature: 4000 },
      { highlights: -30 },
      { colorNR: 40 },
      { masks: [MASK] },
      { processVersion: 1 },
      { contrast: 30 },
    ];
    for (const p of core) expect(withParams(p, "decode")).toBe(decode);
    expect(key({ cut: "decode", context: "other" })).toBe(decode);
    const bag = { ...inputs().bag, "up.stage.amount": 2 };
    expect(key({ cut: "decode", bag })).not.toBe(decode);
    const textureVersions = { "up.stage.lut": 2, "down.stage.lut": 1 };
    expect(key({ cut: "decode", textureVersions })).not.toBe(decode);
    // Without a patched source, the split draw heals in the shader first.
    expect(withParams({ retouch: [SPOT] }, "decode")).not.toBe(decode);
  });
});

// The renderer asks for a token on every frame. Serialising the develop
// params (brush dabs included) is the cost worth avoiding, so it must happen
// only when the params object is replaced.
describe("SplitTokens", () => {
  const sources = (over: Partial<SplitSources> = {}): SplitSources => {
    const { params, bag, textureVersions, context } = inputs();
    return { params, bag, textureVersions, context, ...over };
  };
  const split = (cut: SplitCut): StageSplit => ({ index: 0, cut, upstreamStageIds: ["up.stage"] });

  /** The tokens `steps` get, and how many JSON.stringify calls they took. */
  function run(tokens: SplitTokens, s: StageSplit, steps: SplitSources[]) {
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const issued = steps.map((step) => tokens.token("own.stage", s, step));
      return { issued, serialised: stringify.mock.calls.length };
    } finally {
      stringify.mockRestore();
    }
  }

  it("serialises nothing while no input changes, nor for the stage's own param", () => {
    const tokens = new SplitTokens();
    const s = split("scene");
    const base = sources();
    const first = tokens.token("own.stage", s, base);
    const own = { ...base, bag: { ...base.bag, "own.stage.take": 0 } };
    const { issued, serialised } = run(tokens, s, [base, base, base, own, own]);
    expect(issued).toEqual([first, first, first, first, first]);
    expect(serialised).toBe(0);
  });

  it("serialises replaced params once and keeps the token if nothing upstream moved", () => {
    const tokens = new SplitTokens();
    const s = split("scene");
    const base = sources();
    const first = tokens.token("own.stage", s, base);
    const contrast = { ...base, params: { ...base.params, contrast: 30 } };
    const exposure = { ...base, params: { ...base.params, exposure: 1 } };
    const downstream = run(tokens, s, [contrast, contrast]);
    expect(downstream.issued).toEqual([first, first]);
    expect(downstream.serialised).toBe(1);
    const upstream = run(tokens, s, [exposure]);
    expect(upstream.issued[0]).not.toBe(first);
  });

  // A slider frame replaces the params object and keeps every array in it. A decode
  // cut reads the retouch alone, so a frame that kept the retouch has nothing to
  // serialise, however many dabs it holds.
  describe("for a decode cut", () => {
    const retouched = () => sources({ params: { ...freshParams(5000), retouch: [SPOT] } });
    const frame = (s: SplitSources, over: Partial<DevelopParams>): SplitSources => ({
      ...s,
      params: { ...s.params, ...over },
    });

    it("serialises nothing for slider frames that keep the retouch array", () => {
      const tokens = new SplitTokens();
      const s = split("decode");
      const base = retouched();
      const first = tokens.token("own.stage", s, base);
      const frames = [1, 2, 3].map((exposure) => frame(base, { exposure }));
      const { issued, serialised } = run(tokens, s, frames);
      expect(issued).toEqual([first, first, first]);
      expect(serialised).toBe(0);
    });

    it("serialises a replaced retouch array once, and issues a token only if it differs", () => {
      const tokens = new SplitTokens();
      const s = split("decode");
      const base = retouched();
      const first = tokens.token("own.stage", s, base);

      const edited = frame(base, { retouch: [{ ...SPOT, radius: 0.2 }] });
      const edit = run(tokens, s, [edited, frame(edited, { exposure: 1 })]);
      expect(edit.serialised).toBe(1);
      expect(edit.issued[0]).not.toBe(first);
      expect(edit.issued[1]).toBe(edit.issued[0]);

      const copied = frame(edited, { retouch: structuredClone(edited.params.retouch) });
      const copy = run(tokens, s, [copied]);
      expect(copy.serialised).toBe(1);
      expect(copy.issued[0]).toBe(edit.issued[0]);
    });

    it("keeps following the retouch it last saw, not the one before", () => {
      const tokens = new SplitTokens();
      const s = split("decode");
      const base = retouched();
      const first = tokens.token("own.stage", s, base);
      const cleared = frame(base, { retouch: [] });
      const afterClear = tokens.token("own.stage", s, cleared);
      expect(afterClear).not.toBe(first);
      expect(tokens.token("own.stage", s, frame(cleared, { exposure: 1 }))).toBe(afterClear);
      expect(tokens.token("own.stage", s, frame(base, { exposure: 1 }))).not.toBe(afterClear);
    });
  });

  // Tokens stand in for splitUpstreamKey in the prepass signature, so they
  // must change exactly when it does.
  it("issues a new token exactly when the key changes, for every cut", () => {
    const base = sources();
    const steps: SplitSources[] = [
      base,
      base,
      { ...base, params: structuredClone(base.params) },
      { ...base, params: { ...base.params, contrast: 30 } },
      { ...base, params: { ...base.params, exposure: 1 } },
      { ...base, params: { ...base.params, retouch: [SPOT] } },
      { ...base, params: { ...base.params, crop: { x: 0.1, y: 0, width: 0.5, height: 1 } } },
      { ...base, bag: { ...base.bag, "own.stage.take": 0 } },
      { ...base, bag: { ...base.bag, "up.stage.amount": 2 } },
      { ...base, bag: { ...base.bag, "up.stage.amount": 2 } },
      { ...base, textureVersions: { "up.stage.lut": 2, "down.stage.lut": 1 } },
      { ...base, textureVersions: { "up.stage.lut": 2, "down.stage.lut": 5 } },
      { ...base, context: "other" },
      { ...base, context: "third" },
    ];
    for (const cut of ["decode", "scene", "display"] as const) {
      const tokens = new SplitTokens();
      const s = split(cut);
      const keys = steps.map((step) =>
        splitUpstreamKey({ ...step, cut, upstreamStageIds: s.upstreamStageIds }),
      );
      const issued = steps.map((step) => tokens.token("own.stage", s, step));
      for (let i = 1; i < steps.length; i++) {
        expect(issued[i] !== issued[i - 1], `${cut} step ${i}`).toBe(keys[i] !== keys[i - 1]);
      }
    }
  });

  it("keeps each stage's token apart, and forgets them on clear", () => {
    const tokens = new SplitTokens();
    const s = split("scene");
    const base = sources();
    const exposed = { ...base, params: { ...base.params, exposure: 1 } };
    const a = tokens.token("a.stage", s, base);
    const b = tokens.token("b.stage", s, exposed);
    expect(tokens.token("a.stage", s, base)).toBe(a);
    expect(tokens.token("b.stage", s, exposed)).toBe(b);
    tokens.clear();
    expect(tokens.token("a.stage", s, base)).not.toBe(a);
  });
});
