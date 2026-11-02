// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What the Develop view hands the renderer: the edit with its bypassed panels
// neutralised and, while a canvas tool asks for it, passed through the tool's
// view params (crop mode widens the crop to the transformed view). Either builds
// a new object whenever it applies, and the bridge posts each object once, so a
// view that asks again for the same inputs (every extension-slider frame does)
// must get the object it already posted: else every frame clones every brush dab.

import { describe, expect, it } from "vitest";
import { DEFAULT_DEVELOP_PARAMS, type CropRect, type DevelopParams } from "@/catalog/types";
import { applyPanelBypass } from "@/modules/develop/panel-bypass";
import { createRenderParams, type RenderParamsFor } from "./render-params";

const ASPECT = 1.5;
const OPEN: Record<string, boolean> = {};
const BASIC_OFF: Record<string, boolean> = { "core.basic": true };

const edit = (over: Partial<DevelopParams> = {}): DevelopParams => ({
  ...DEFAULT_DEVELOP_PARAMS,
  exposure: 1,
  straighten: 4,
  ...over,
});

/** A view as crop mode draws it: a crop from the rest of the params alone. */
const wideCrop = (p: DevelopParams): CropRect => ({ x: -p.straighten / 100, y: 0, width: 1.2, height: 1 });
const widen = (p: DevelopParams): DevelopParams => ({ ...p, crop: wideCrop(p) });

describe("createRenderParams", () => {
  describe("what it draws", () => {
    it("is the params themselves while no panel is bypassed and no view is asked for", () => {
      const params = edit();
      expect(createRenderParams()(params, null, ASPECT, OPEN)).toBe(params);
    });

    it("resets a bypassed panel's params and leaves the stored edit alone", () => {
      const params = edit({ contrast: 30 });
      const drawn = createRenderParams()(params, null, ASPECT, BASIC_OFF);
      expect(drawn).toEqual(applyPanelBypass(params, BASIC_OFF));
      expect(drawn).toMatchObject({ exposure: 0, contrast: 0, straighten: 4 });
      expect(params).toMatchObject({ exposure: 1, contrast: 30 });
    });

    it("passes the params as bypassed through the view", () => {
      const params = edit({ crop: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 } });
      const drawn = createRenderParams()(params, widen, ASPECT, BASIC_OFF);
      expect(drawn).toEqual(widen(applyPanelBypass(params, BASIC_OFF)));
      expect(params.crop).toEqual({ x: 0.2, y: 0.2, width: 0.5, height: 0.5 });
    });
  });

  describe("asked again", () => {
    it("returns the same object for the same inputs, with a view", () => {
      const render = createRenderParams();
      const params = edit();
      const first = render(params, widen, ASPECT, OPEN);
      expect(render(params, widen, ASPECT, OPEN)).toBe(first);
    });

    it("returns the same object for the same inputs, with a panel bypassed", () => {
      const render = createRenderParams();
      const params = edit();
      const first = render(params, null, ASPECT, BASIC_OFF);
      expect(render(params, null, ASPECT, BASIC_OFF)).toBe(first);
    });

    // Crop mode draws the transformed view in place of the crop, so dragging the crop
    // box changes nothing drawn: each step of the drag was posted and rendered again.
    it("returns the same object while the view draws the same values", () => {
      const render = createRenderParams();
      const params = edit();
      const first = render(params, widen, ASPECT, OPEN);
      const moved = { ...params, crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } };
      expect(render(moved, widen, ASPECT, OPEN)).toBe(first);
      const again = { ...moved, crop: { x: 0.2, y: 0.1, width: 0.5, height: 0.5 } };
      expect(render(again, widen, ASPECT, OPEN)).toBe(first);
    });

    it("returns a new object once the view draws something else", () => {
      const render = createRenderParams();
      const params = edit();
      const first = render(params, widen, ASPECT, OPEN);
      expect(render({ ...params, exposure: 2 }, widen, ASPECT, OPEN)).not.toBe(first);
      expect(render({ ...params, straighten: 2 }, widen, ASPECT, OPEN)).not.toBe(first);
    });

    it("returns the params with their new crop without a view", () => {
      const render = createRenderParams();
      const params = edit();
      render(params, null, ASPECT, OPEN);
      const moved = { ...params, crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } };
      expect(render(moved, null, ASPECT, OPEN)).toBe(moved);
    });

    // Each case changes one input of a call that was just remembered, so a memo that
    // forgot to compare it would hand back the old object. The replacements are
    // equal in value to what they replace: only their identity differs.
    const params = edit();
    const replacedParams = { ...params, masks: [...params.masks], vignette: { ...params.vignette, amount: -30 } };
    const replacedBypass = { ...BASIC_OFF, "core.effects": true };
    const otherView = (p: DevelopParams): DevelopParams => ({ ...p, crop: { x: 0, y: 0, width: 2, height: 2 } });
    const changes: [string, (render: RenderParamsFor) => DevelopParams][] = [
      ["params", (r) => r(replacedParams, widen, ASPECT, BASIC_OFF)],
      ["the view", (r) => r(params, otherView, ASPECT, BASIC_OFF)],
      ["the aspect", (r) => r(params, widen, 1, BASIC_OFF)],
      ["the bypassed panels", (r) => r(params, widen, ASPECT, replacedBypass)],
    ];
    it.each(changes)("returns a new object once %s changes, and keeps that one", (_, change) => {
      const render = createRenderParams();
      const before = render(params, widen, ASPECT, BASIC_OFF);
      const after = change(render);
      expect(after).not.toBe(before);
      expect(change(render)).toBe(after);
    });

    it("keeps nothing between two memos", () => {
      const params = edit();
      const a = createRenderParams()(params, widen, ASPECT, OPEN);
      const b = createRenderParams()(params, widen, ASPECT, OPEN);
      expect(b).not.toBe(a);
      expect(b).toEqual(a);
    });
  });
});
