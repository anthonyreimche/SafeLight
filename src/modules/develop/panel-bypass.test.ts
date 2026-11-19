// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A held panel's preview-off eye resets the develop params the panel owns: the
// ones its contribution declares (PanelContribution.owns), else the built-in
// list for the Essentials that don't declare them yet.

import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_DEVELOP_PARAMS, type DevelopParams } from "@/catalog/types";
import { useRegistry, type RegisteredPanel, type RegisteredProcessingStage } from "@/extensions/registry";
import { registerStageParams, unregisterExtensionParams } from "@/extensions/param-registry";
import { applyPanelBypass, bypassParamBag, panelIsPreviewable } from "./panel-bypass";

const panel = (id: string, extensionId: string, owns?: RegisteredPanel["owns"]): RegisteredPanel => ({
  id,
  title: id,
  component: () => null,
  extensionId,
  ...(owns && { owns }),
});

const withPanels = (...panels: RegisteredPanel[]) => ({
  ...useRegistry.getState(),
  panels: Object.fromEntries(panels.map((p) => [p.id, p])),
  processingStages: {},
});

const edited: DevelopParams = {
  ...DEFAULT_DEVELOP_PARAMS,
  exposure: 1,
  contrast: 30,
  vignette: { ...DEFAULT_DEVELOP_PARAMS.vignette, amount: -20 },
  sharpening: 60,
  luminanceNR: 40,
};

afterEach(() => unregisterExtensionParams("my-ext"));

describe("a panel that declares owns", () => {
  const state = withPanels(panel("my-ext.tone", "my-ext", ["exposure", "vignette"]));
  const held = { "my-ext.tone": true };

  it("resets those params while held, and nothing else", () => {
    const drawn = applyPanelBypass(edited, held, state);
    expect(drawn.exposure).toBe(DEFAULT_DEVELOP_PARAMS.exposure);
    expect(drawn.vignette).toEqual(DEFAULT_DEVELOP_PARAMS.vignette);
    expect(drawn.contrast).toBe(30);
    expect(edited.exposure).toBe(1);
  });

  it("can be previewed off without a stage of its own", () => {
    expect(panelIsPreviewable("my-ext.tone", state)).toBe(true);
    expect(panelIsPreviewable("my-ext.info", withPanels(panel("my-ext.info", "my-ext")))).toBe(false);
  });

  // Its owned params are what the eye hides; the extension's other stages
  // belong to its other panels.
  it("leaves its extension's stage params alone", () => {
    registerStageParams("my-ext.glow", "Glow", "my-ext", [{ key: "amount", glslType: "float", default: 0 }]);
    const bag = { "my-ext.glow.amount": 5 };
    expect(bypassParamBag(bag, held, state)).toBe(bag);
  });

  it("drops an extension panel's stage params when it owns none", () => {
    registerStageParams("my-ext.glow", "Glow", "my-ext", [{ key: "amount", glslType: "float", default: 0 }]);
    const bare = withPanels(panel("my-ext.glow-panel", "my-ext"));
    const bag = { "my-ext.glow.amount": 5, "other.x.y": 1 };
    expect(bypassParamBag(bag, { "my-ext.glow-panel": true }, bare)).toEqual({ "other.x.y": 1 });
  });

  it("drops its stages' texture values too, which have no uniform of their own", () => {
    const stage = { id: "my-ext.paint", extensionId: "my-ext" } as RegisteredProcessingStage;
    const other = { id: "other.paint", extensionId: "other" } as RegisteredProcessingStage;
    const bare = {
      ...withPanels(panel("my-ext.paint-panel", "my-ext")),
      processingStages: { [stage.id]: stage, [other.id]: other },
    };
    const bag = { "my-ext.paint.layers": [{ id: "a", dabs: [] }], "other.paint.layers": [] };
    expect(bypassParamBag(bag, { "my-ext.paint-panel": true }, bare)).toEqual({ "other.paint.layers": [] });
  });

  it("takes the place of the built-in list for an Essential's panel", () => {
    const declared = withPanels(panel("core.detail", "safelight.detail", ["sharpening"]));
    const drawn = applyPanelBypass(edited, { "core.detail": true }, declared);
    expect(drawn.sharpening).toBe(DEFAULT_DEVELOP_PARAMS.sharpening);
    expect(drawn.luminanceNR).toBe(40);
  });
});

// One extension can run many panels off the same stage (a filter store whose
// filters each get a panel), so a panel can name the bag keys its own effect
// lives in and the eye hides only those.
describe("a panel that declares ownsBag", () => {
  const stage = { id: "gmic.f", extensionId: "gmic" } as RegisteredProcessingStage;
  const withBagPanels = (...panels: RegisteredPanel[]) => ({
    ...withPanels(...panels),
    processingStages: { [stage.id]: stage },
  });
  const bagPanel = (id: string, ownsBag: readonly string[], owns?: RegisteredPanel["owns"]): RegisteredPanel => ({
    ...panel(id, "gmic", owns),
    ownsBag,
  });
  const bag = {
    "gmic.f.abc.amount": 5,
    "gmic.f.abc.mode": 2,
    "gmic.f.abcd.amount": 3,
    "gmic.f.def.amount": 7,
    "gmic.f.order": ["abc", "def"],
  };

  it("drops only the keys under its prefixes and exact keys", () => {
    const state = withBagPanels(bagPanel("gmic.abc", ["gmic.f.abc.", "gmic.f.order"]), bagPanel("gmic.def", ["gmic.f.def."]));
    expect(bypassParamBag(bag, { "gmic.abc": true }, state)).toEqual({
      "gmic.f.abcd.amount": 3,
      "gmic.f.def.amount": 7,
    });
  });

  it("leaves the bag alone while its eye isn't held", () => {
    const state = withBagPanels(bagPanel("gmic.abc", ["gmic.f.abc."]));
    expect(bypassParamBag(bag, { "gmic.abc": false }, state)).toBe(bag);
  });

  it("drops only its own keys from the extension's view values drawn over the bag", () => {
    const state = withBagPanels(bagPanel("gmic.abc", ["gmic.f.abc."]));
    const shown = { ...bag, "gmic.f.abc.highlight": 1, "gmic.f.def.highlight": 1 };
    expect(bypassParamBag(shown, { "gmic.abc": true }, state)).toEqual({
      "gmic.f.abcd.amount": 3,
      "gmic.f.def.amount": 7,
      "gmic.f.order": ["abc", "def"],
      "gmic.f.def.highlight": 1,
    });
  });

  it("previews both off when it also declares owns", () => {
    const state = withBagPanels(bagPanel("gmic.abc", ["gmic.f.abc."], ["exposure"]));
    const held = { "gmic.abc": true };
    expect(applyPanelBypass(edited, held, state).exposure).toBe(DEFAULT_DEVELOP_PARAMS.exposure);
    expect(bypassParamBag(bag, held, state)).toEqual({
      "gmic.f.abcd.amount": 3,
      "gmic.f.def.amount": 7,
      "gmic.f.order": ["abc", "def"],
    });
  });

  it("can be previewed off without a stage of its extension's", () => {
    expect(panelIsPreviewable("gmic.abc", withPanels(bagPanel("gmic.abc", ["gmic.f.abc."])))).toBe(true);
    expect(panelIsPreviewable("gmic.none", withPanels(bagPanel("gmic.none", [])))).toBe(false);
  });

  it("an empty list owns nothing, even beside its extension's stages: no eye, nothing held off", () => {
    const state = withBagPanels(bagPanel("gmic.store", []));
    expect(panelIsPreviewable("gmic.store", state)).toBe(false);
    expect(bypassParamBag(bag, { "gmic.store": true }, state)).toBe(bag);
  });
});

describe("an Essential's panel that doesn't declare owns", () => {
  it("resets the built-in list's params, noise reduction with Detail's sharpening", () => {
    const state = withPanels(panel("core.detail", "safelight.detail"));
    const drawn = applyPanelBypass(edited, { "core.detail": true }, state);
    expect(drawn.sharpening).toBe(DEFAULT_DEVELOP_PARAMS.sharpening);
    expect(drawn.luminanceNR).toBe(DEFAULT_DEVELOP_PARAMS.luminanceNR);
    expect(panelIsPreviewable("core.detail", state)).toBe(true);
  });

  it("is the same object back when nothing held owns params", () => {
    expect(applyPanelBypass(edited, { "core.detail": false }, withPanels())).toBe(edited);
  });
});
