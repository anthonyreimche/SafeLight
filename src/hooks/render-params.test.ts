// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What the Develop view hands the renderer: the edit with its bypassed panels
// neutralised and, in crop mode, the crop widened to the transformed view. Either
// builds a new object whenever it applies, and the bridge posts each object once, so a
// view that asks again for the same inputs (every extension-slider frame does) must
// get the object it already posted: else every frame clones every brush dab.

import { describe, expect, it } from "vitest";
import { DEFAULT_DEVELOP_PARAMS, type DevelopParams } from "@/catalog/types";
import { applyPanelBypass } from "@/modules/develop/panel-bypass";
import { transformedViewCrop } from "@/rendering/crop-transform";
import { buildForwardTransform } from "@/rendering/transform";
import { createRenderParams, type RenderParamsFor } from "./render-params";

const ASPECT = 1.5;
const OPEN: Record<string, boolean> = {};
const BASIC_OFF: Record<string, boolean> = { "core.basic": true };
const TRANSFORM_OFF: Record<string, boolean> = { "core.transform": true };

const edit = (over: Partial<DevelopParams> = {}): DevelopParams => ({
  ...DEFAULT_DEVELOP_PARAMS,
  exposure: 1,
  straighten: 4,
  ...over,
});

const viewCrop = (p: DevelopParams, aspect = ASPECT) =>
  transformedViewCrop(buildForwardTransform(p.straighten, p.transform, aspect));

describe("createRenderParams", () => {
  describe("what it draws", () => {
    it("is the params themselves while no panel is bypassed and the crop tool is closed", () => {
      const params = edit();
      expect(createRenderParams()(params, false, ASPECT, OPEN)).toBe(params);
    });

    it("resets a bypassed panel's params and leaves the stored edit alone", () => {
      const params = edit({ contrast: 30 });
      const drawn = createRenderParams()(params, false, ASPECT, BASIC_OFF);
      expect(drawn).toEqual(applyPanelBypass(params, BASIC_OFF));
      expect(drawn).toMatchObject({ exposure: 0, contrast: 0, straighten: 4 });
      expect(params).toMatchObject({ exposure: 1, contrast: 30 });
    });

    it("widens the crop to the transformed view in crop mode and changes nothing else", () => {
      const params = edit({ crop: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 } });
      const drawn = createRenderParams()(params, true, ASPECT, OPEN);
      expect(drawn.crop).toEqual(viewCrop(params));
      expect(drawn.crop).not.toEqual(params.crop);
      expect({ ...drawn, crop: params.crop }).toEqual(params);
    });

    it("derives that crop from the params as bypassed, and from the aspect it is given", () => {
      const params = edit();
      const render = createRenderParams();
      const unrotated = render(params, true, ASPECT, TRANSFORM_OFF);
      expect(unrotated.straighten).toBe(0);
      expect(unrotated.crop).toEqual(viewCrop({ ...params, straighten: 0 }));
      expect(unrotated.crop).not.toEqual(viewCrop(params));
      expect(render(params, true, 1, OPEN).crop).toEqual(viewCrop(params, 1));
      expect(render(params, true, 1, OPEN).crop).not.toEqual(viewCrop(params));
    });
  });

  describe("asked again", () => {
    it("returns the same object for the same inputs, in crop mode", () => {
      const render = createRenderParams();
      const params = edit();
      const first = render(params, true, ASPECT, OPEN);
      expect(render(params, true, ASPECT, OPEN)).toBe(first);
      expect(render(params, true, ASPECT, OPEN)).toBe(first);
    });

    it("returns the same object for the same inputs, with a panel bypassed", () => {
      const render = createRenderParams();
      const params = edit();
      const first = render(params, false, ASPECT, BASIC_OFF);
      expect(render(params, false, ASPECT, BASIC_OFF)).toBe(first);
    });

    it("returns the same object for the same inputs, with both", () => {
      const render = createRenderParams();
      const params = edit();
      const first = render(params, true, ASPECT, TRANSFORM_OFF);
      expect(render(params, true, ASPECT, TRANSFORM_OFF)).toBe(first);
    });

    // Each case changes one input of a call that was just remembered, so a memo that
    // forgot to compare it would hand back the old object. The replacements are
    // equal in value to what they replace: only their identity differs.
    const params = edit();
    const replacedParams = { ...params };
    const replacedBypass = { ...BASIC_OFF };
    const changes: [string, (render: RenderParamsFor) => DevelopParams][] = [
      ["params", (r) => r(replacedParams, true, ASPECT, BASIC_OFF)],
      ["the crop tool", (r) => r(params, false, ASPECT, BASIC_OFF)],
      ["the aspect", (r) => r(params, true, 1, BASIC_OFF)],
      ["the bypassed panels", (r) => r(params, true, ASPECT, replacedBypass)],
    ];
    it.each(changes)("returns a new object once %s changes, and keeps that one", (_, change) => {
      const render = createRenderParams();
      const before = render(params, true, ASPECT, BASIC_OFF);
      const after = change(render);
      expect(after).not.toBe(before);
      expect(change(render)).toBe(after);
    });

    it("keeps nothing between two memos", () => {
      const params = edit();
      const a = createRenderParams()(params, true, ASPECT, OPEN);
      const b = createRenderParams()(params, true, ASPECT, OPEN);
      expect(b).not.toBe(a);
      expect(b).toEqual(a);
    });
  });
});
