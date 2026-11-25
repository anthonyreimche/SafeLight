// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The official brush every painting tool shares (api.develop.brush): its
// defaults, and what each rebindable brush shortcut does to it.

import { describe, expect, it } from "vitest";
import { BRUSH_ACTIONS, BRUSH_DEFAULTS, stepBrush } from "./brush";
import { KEY_ACTIONS } from "@/state/keybindings-store";

describe("the official brush", () => {
  it("starts as Masking's brush always has", () => {
    expect(BRUSH_DEFAULTS).toEqual({ size: 0.08, feather: 0.5, opacity: 1, flow: 1 });
  });

  it("answers every brush shortcut there is, and no other", () => {
    const bound = KEY_ACTIONS.map((b) => b.id).filter((id) => id.startsWith("brush."));
    expect([...BRUSH_ACTIONS].sort()).toEqual([...bound].sort());
  });

  it("steps size by 1 %, feather by 5 % and opacity and flow by 10 %", () => {
    const brush = { size: 0.08, feather: 0.5, opacity: 0.5, flow: 0.5 };
    expect(stepBrush("brush.larger", brush)).toEqual({ key: "size", value: 0.09 });
    expect(stepBrush("brush.smaller", brush)).toEqual({ key: "size", value: 0.07 });
    expect(stepBrush("brush.featherUp", brush)).toEqual({ key: "feather", value: 0.55 });
    expect(stepBrush("brush.featherDown", brush)).toEqual({ key: "feather", value: 0.45 });
    expect(stepBrush("brush.opacityUp", brush)).toEqual({ key: "opacity", value: 0.6 });
    expect(stepBrush("brush.opacityDown", brush)).toEqual({ key: "opacity", value: 0.4 });
    expect(stepBrush("brush.flowUp", brush)).toEqual({ key: "flow", value: 0.6 });
    expect(stepBrush("brush.flowDown", brush)).toEqual({ key: "flow", value: 0.4 });
  });

  it("holds each setting to its range", () => {
    expect(stepBrush("brush.larger", { size: 0.5 })).toEqual({ key: "size", value: 0.5 });
    expect(stepBrush("brush.smaller", { size: 0.01 })).toEqual({ key: "size", value: 0.01 });
    expect(stepBrush("brush.featherDown", { feather: 0 })).toEqual({ key: "feather", value: 0 });
    expect(stepBrush("brush.featherUp", { feather: 1 })).toEqual({ key: "feather", value: 1 });
    expect(stepBrush("brush.opacityDown", { opacity: 0.05 })).toEqual({ key: "opacity", value: 0.01 });
    expect(stepBrush("brush.flowUp", { flow: 0.95 })).toEqual({ key: "flow", value: 1 });
  });

  it("never moves a setting the wrong way, even from outside its range", () => {
    expect(stepBrush("brush.smaller", { size: 0.004 })).toEqual({ key: "size", value: 0.004 });
    expect(stepBrush("brush.larger", { size: 0.6 })).toEqual({ key: "size", value: 0.6 });
  });

  it("holds a setting to the tool's own range when it gives one", () => {
    const eye = { size: 0.004 };
    const range = { size: { min: 0.002, max: 0.1 } };
    expect(stepBrush("brush.smaller", eye, range)).toEqual({ key: "size", value: 0.002 });
    expect(stepBrush("brush.larger", eye, range)).toEqual({ key: "size", value: 0.014 });
    expect(stepBrush("brush.larger", { size: 0.095 }, range)).toEqual({ key: "size", value: 0.1 });
    expect(stepBrush("brush.featherUp", { feather: 0.98 }, range)).toEqual({ key: "feather", value: 1 });
  });

  it("leaves a setting the tool doesn't have, and any other action, to the next handler", () => {
    expect(stepBrush("brush.flowUp", { size: 0.08, feather: 0.5 })).toBeNull();
    expect(stepBrush("mask.delete", BRUSH_DEFAULTS)).toBeNull();
    expect(stepBrush("develop.undo", BRUSH_DEFAULTS)).toBeNull();
  });
});
