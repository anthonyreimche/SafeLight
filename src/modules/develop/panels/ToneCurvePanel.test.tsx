// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Preferences ▸ Tone Curve ▸ Show point values, end to end: the toggle the
// Tone Curve extension registers is the one the panel and its mask instance
// read, and flipping it shows the In/Out boxes without reopening the panel.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The store's mutations broadcast to sibling windows; that side effect is not
// under test and needs no BroadcastChannel here.
vi.mock("@/state/broadcast", () => ({
  broadcast: () => {},
  onBroadcast: () => () => {},
  WINDOW_ID: "test-window",
}));

import { act, render, screen } from "@testing-library/react";
import { normalizeParams } from "@/catalog/types";
import { BUILTIN_EXTENSIONS } from "@/extensions/builtin";
import { setExtSetting, useExtSettings } from "@/extensions/ext-settings";
import { makeScopedAPI } from "@/extensions/host";
import { unregisterExtension, useRegistry } from "@/extensions/registry";
import { MaskScopeProvider } from "@/modules/develop/mask-scope";
import { useDevelopStore } from "@/state/develop-store";
import { TONE_CURVE_MASK_PANEL, ToneCurvePanel } from "./ToneCurvePanel";

const TONE_CURVE = "core.tone-curve";

class FixedWidthObserver {
  private readonly cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(): void {
    this.cb([{ contentRect: { width: 216 } }] as never, this as never);
  }
  unobserve(): void {}
  disconnect(): void {}
}

// jsdom has no 2D canvas; drawing only has to not throw.
const noopContext = new Proxy({}, { get: () => () => {}, set: () => true });
const realGetContext = HTMLCanvasElement.prototype.getContext;

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", FixedWidthObserver);
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => noopContext,
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: realGetContext,
  });
});

beforeEach(() => {
  const params = normalizeParams({});
  useDevelopStore.setState({
    photoId: "photo-1",
    params,
    paramBag: {},
    history: [{ timestamp: 0, label: "Original", params, paramBag: {} }],
    historyIndex: 0,
  });
  const toneCurve = BUILTIN_EXTENSIONS.find((e) => e.id === TONE_CURVE);
  if (!toneCurve) throw new Error("no Tone Curve built-in extension");
  toneCurve.activate(makeScopedAPI(TONE_CURVE));
});

afterEach(() => {
  unregisterExtension(TONE_CURVE);
  localStorage.clear();
  useExtSettings.setState({}, true);
});

const inField = () => screen.queryByLabelText<HTMLInputElement>("Selected point input level (0–255)");

function turnOnPointValues(): void {
  const field = useRegistry
    .getState()
    .settings[TONE_CURVE]?.fields.find((f) => f.label === "Show point values");
  if (!field) throw new Error("no Show point values field");
  setExtSetting(TONE_CURVE, field.key, true);
}

describe("Show point values", () => {
  it("is registered off in Preferences ▸ Tone Curve", () => {
    const section = useRegistry.getState().settings[TONE_CURVE];
    expect(section?.title).toBe("Tone Curve");
    expect(section?.fields).toContainEqual(
      expect.objectContaining({ label: "Show point values", type: "boolean", default: false }),
    );
    render(<ToneCurvePanel />);
    expect(inField()).toBeNull();
  });

  it("shows the selected point's levels in the Tone Curve panel", () => {
    turnOnPointValues();
    render(<ToneCurvePanel />);
    expect(inField()?.value).toBe("0");
  });

  it("takes effect in an open panel", () => {
    render(<ToneCurvePanel />);
    expect(inField()).toBeNull();
    act(() => turnOnPointValues());
    expect(inField()).not.toBeNull();
  });

  it("shows them in a mask's Tone Curve too", () => {
    turnOnPointValues();
    useDevelopStore.getState().addRangeComponent("lumRange");
    const maskId = useDevelopStore.getState().params.masks[0].id;
    const MaskPanel = TONE_CURVE_MASK_PANEL.component;
    render(
      <MaskScopeProvider maskId={maskId}>
        <MaskPanel />
      </MaskScopeProvider>,
    );
    expect(inField()?.value).toBe("0");
  });
});
