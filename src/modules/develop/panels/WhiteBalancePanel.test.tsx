// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// White Balance panel driven against a real develop store. The global Temp
// slider is absolute Kelvin anchored on the photo's as-shot value; the per-mask
// instance is a relative −100..100 shift of it. Nothing here pins a particular
// Kelvin to a particular photo — only the relationships (opens on as-shot,
// resets to as-shot, clamps at the 2000/50000 bounds).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The store's mutations broadcast to sibling windows; that side effect is not
// under test and needs no BroadcastChannel here.
vi.mock("@/state/broadcast", () => ({
  broadcast: () => {},
  onBroadcast: () => () => {},
  WINDOW_ID: "test-window",
}));

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { normalizeParams } from "@/catalog/types";
import { useDevelopStore } from "@/state/develop-store";
import { useSettings } from "@/state/settings-store";
import { MaskScopeProvider } from "@/modules/develop/mask-scope";
import type { HistogramData } from "@/rendering/histogram";
import { WHITE_BALANCE_MASK_PANEL, WhiteBalancePanel } from "./WhiteBalancePanel";

// Off the 6500 K neutral and off the slider's 10 K snap grid, so "opens on
// as-shot" and "reset restores as-shot" cannot pass by coincidence.
const AS_SHOT = 4237;

const HISTOGRAM: HistogramData = {
  r: new Uint32Array(256),
  g: new Uint32Array(256),
  b: new Uint32Array(256),
  luma: new Uint32Array(256),
};

// jsdom has no layout — every getBoundingClientRect is zero-sized — and the
// Slider derives value-per-pixel from the track width, so a drag over a
// zero-width track is a no-op.
const TRACK_WIDTH = 100;
const trackRect = (): DOMRect => ({
  x: 0,
  y: 0,
  left: 0,
  top: 0,
  right: TRACK_WIDTH,
  bottom: 16,
  width: TRACK_WIDTH,
  height: 16,
  toJSON: () => ({}),
});

function seedPhoto(asShot = AS_SHOT, histogram: HistogramData | null = null) {
  const params = normalizeParams({ temperature: asShot });
  useDevelopStore.setState({
    photoId: "photo-1",
    asShotTemperature: asShot,
    params,
    paramBag: {},
    history: [{ timestamp: 0, label: "Original", params, paramBag: {} }],
    historyIndex: 0,
    histogram,
    wbPicking: false,
  });
}

/** Press on the track, travel `dx` pixels, release — the gesture the Slider
 *  turns into a committed value. */
async function drag(
  user: ReturnType<typeof userEvent.setup>,
  track: HTMLElement,
  dx: number,
) {
  await user.pointer([
    { keys: "[MouseLeft>]", target: track, coords: { clientX: 0, clientY: 8 } },
    { target: track, coords: { clientX: dx, clientY: 8 } },
    { keys: "[/MouseLeft]", target: track, coords: { clientX: dx, clientY: 8 } },
  ]);
}

const temperature = () => useDevelopStore.getState().params.temperature;
const topOfHistory = () => {
  const { history, historyIndex } = useDevelopStore.getState();
  return history[historyIndex];
};

beforeEach(() => {
  vi.spyOn(HTMLInputElement.prototype, "getBoundingClientRect").mockImplementation(
    trackRect,
  );
  useSettings.setState({ sliderJumpToCursor: false });
  seedPhoto();
});

afterEach(() => vi.restoreAllMocks());

describe("Temp slider", () => {
  it("spans the absolute Kelvin range and opens on the photo's as-shot value", () => {
    render(<WhiteBalancePanel />);
    const temp = screen.getByRole<HTMLInputElement>("slider", { name: "Temp" });
    expect([temp.min, temp.max, temp.step]).toEqual(["2000", "50000", "10"]);
    expect(Number(temp.value)).toBe(useDevelopStore.getState().asShotTemperature);
  });

  it("commits a dragged value snapped to the step, under one labelled history entry", async () => {
    const user = userEvent.setup();
    render(<WhiteBalancePanel />);
    await drag(user, screen.getByRole("slider", { name: "Temp" }), 10);

    expect(temperature()).toBeGreaterThan(AS_SHOT);
    expect(temperature() % 10).toBe(0);
    expect(topOfHistory().label).toBe("Temperature");
    expect(topOfHistory().params.temperature).toBe(temperature());
  });

  it("clamps at 50000 K when dragged past the top of the track", async () => {
    const user = userEvent.setup();
    render(<WhiteBalancePanel />);
    await drag(user, screen.getByRole("slider", { name: "Temp" }), TRACK_WIDTH * 4);
    expect(temperature()).toBe(50000);
  });

  it("clamps at 2000 K when dragged past the bottom of the track", async () => {
    const user = userEvent.setup();
    render(<WhiteBalancePanel />);
    await drag(user, screen.getByRole("slider", { name: "Temp" }), -TRACK_WIDTH * 4);
    expect(temperature()).toBe(2000);
  });

  it("restores the as-shot Kelvin on double-click, off the snap grid and all", async () => {
    const user = userEvent.setup();
    render(<WhiteBalancePanel />);
    await drag(user, screen.getByRole("slider", { name: "Temp" }), TRACK_WIDTH * 4);
    expect(temperature()).not.toBe(AS_SHOT);

    await user.dblClick(screen.getByRole("slider", { name: "Temp" }));
    expect(temperature()).toBe(useDevelopStore.getState().asShotTemperature);
  });
});

describe("Tint slider", () => {
  it("is a symmetric shift that resets to neutral, not to the as-shot Kelvin", async () => {
    const user = userEvent.setup();
    render(<WhiteBalancePanel />);
    const tint = screen.getByRole<HTMLInputElement>("slider", { name: "Tint" });
    expect([tint.min, tint.max]).toEqual(["-150", "150"]);

    await drag(user, tint, TRACK_WIDTH);
    expect(useDevelopStore.getState().params.tint).toBe(150);

    await user.dblClick(tint);
    expect(useDevelopStore.getState().params.tint).toBe(0);
  });
});

describe("picker and Auto", () => {
  it("are both inert until a histogram exists", () => {
    render(<WhiteBalancePanel />);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /picker/i }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Auto" }).disabled).toBe(true);
  });

  it("arm and disarm the eyedropper once a histogram is available", async () => {
    seedPhoto(AS_SHOT, HISTOGRAM);
    const user = userEvent.setup();
    render(<WhiteBalancePanel />);
    const picker = screen.getByRole("button", { name: /picker/i });
    expect(picker.getAttribute("aria-pressed")).toBe("false");

    await user.click(picker);
    expect(useDevelopStore.getState().wbPicking).toBe(true);
    expect(picker.getAttribute("aria-pressed")).toBe("true");

    await user.click(picker);
    expect(useDevelopStore.getState().wbPicking).toBe(false);
  });
});

describe("per-mask instance", () => {
  function renderMaskPanel() {
    useDevelopStore.getState().addRangeComponent("lumRange");
    const maskId = useDevelopStore.getState().params.masks[0].id;
    const MaskPanel = WHITE_BALANCE_MASK_PANEL.component;
    render(
      <MaskScopeProvider maskId={maskId}>
        <MaskPanel />
      </MaskScopeProvider>,
    );
    return maskId;
  }

  it("edits a relative −100..100 shift, never the photo's Kelvin", async () => {
    const user = userEvent.setup();
    const maskId = renderMaskPanel();
    const temp = screen.getByRole<HTMLInputElement>("slider", { name: "Temp" });
    expect([temp.min, temp.max, temp.value]).toEqual(["-100", "100", "0"]);

    await drag(user, temp, TRACK_WIDTH);
    const mask = useDevelopStore.getState().params.masks.find((m) => m.id === maskId);
    expect(mask?.adj.temperature).toBe(100);
    expect(temperature()).toBe(AS_SHOT);
  });
});
