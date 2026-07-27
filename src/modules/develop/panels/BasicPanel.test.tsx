// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Basic panel driven against a real develop store: which sliders the panel
// offers, that each carries the shared TONAL_PARAM_RANGE bounds (exposure is EV,
// not a −100..100 strength), and that a gesture lands one labelled history entry
// touching only its own param.

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
import type { HistogramData } from "@/rendering/histogram";
import { BasicPanel } from "./BasicPanel";

const HISTOGRAM: HistogramData = {
  r: new Uint32Array(256),
  g: new Uint32Array(256),
  b: new Uint32Array(256),
  luma: new Uint32Array(256),
};

// The panel's order, which the histogram's draggable zones and the Auto tone
// step both read against.
const CORE_SLIDERS = [
  "Exposure",
  "Contrast",
  "Highlights",
  "Shadows",
  "Whites",
  "Blacks",
  "Texture",
  "Clarity",
  "Dehaze",
  "Vibrance",
  "Saturation",
];

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

function seedPhoto(histogram: HistogramData | null = null) {
  const params = normalizeParams(undefined);
  useDevelopStore.setState({
    photoId: "photo-1",
    params,
    paramBag: {},
    history: [{ timestamp: 0, label: "Original", params, paramBag: {} }],
    historyIndex: 0,
    histogram,
  });
}

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

const sliderLabels = () =>
  screen.getAllByRole("slider").map((s) => s.getAttribute("aria-label"));

beforeEach(() => {
  vi.spyOn(HTMLInputElement.prototype, "getBoundingClientRect").mockImplementation(
    trackRect,
  );
  useSettings.setState({ sliderJumpToCursor: false, basicDetailSliders: false });
  seedPhoto();
});

afterEach(() => vi.restoreAllMocks());

describe("slider set", () => {
  it("hides the per-band detail sliders until the preference opts in", () => {
    render(<BasicPanel />);
    expect(sliderLabels()).toEqual(CORE_SLIDERS);
  });

  it("nests each detail slider under the band it refines", () => {
    useSettings.setState({ basicDetailSliders: true });
    render(<BasicPanel />);
    const labels = sliderLabels();
    expect(labels).toHaveLength(CORE_SLIDERS.length + 2);
    expect(labels.indexOf("Highlight Detail")).toBe(labels.indexOf("Highlights") + 1);
    expect(labels.indexOf("Shadow Detail")).toBe(labels.indexOf("Shadows") + 1);
  });
});

describe("ranges", () => {
  it("gives exposure an EV scale with a tenth-stop step, not a strength scale", () => {
    render(<BasicPanel />);
    const exposure = screen.getByRole<HTMLInputElement>("slider", { name: "Exposure" });
    expect([exposure.min, exposure.max, exposure.step]).toEqual(["-5", "5", "0.1"]);
  });

  it("gives every strength slider the symmetric −100..100 scale", () => {
    useSettings.setState({ basicDetailSliders: true });
    render(<BasicPanel />);
    const strengths = screen
      .getAllByRole<HTMLInputElement>("slider")
      .filter((s) => s.getAttribute("aria-label") !== "Exposure");
    expect(strengths).toHaveLength(CORE_SLIDERS.length + 1);
    const scales = new Set(strengths.map((s) => `${s.min}..${s.max} step ${s.step}`));
    expect([...scales]).toEqual(["-100..100 step 1"]);
  });
});

describe("committing a gesture", () => {
  it("snaps exposure to the tenth-stop grid and labels the history entry", async () => {
    const user = userEvent.setup();
    render(<BasicPanel />);
    // 10 EV across a 100 px track: ten pixels is exactly one stop.
    await drag(user, screen.getByRole("slider", { name: "Exposure" }), 10);

    const { params, history, historyIndex } = useDevelopStore.getState();
    expect(params.exposure).toBe(1);
    expect(history[historyIndex].label).toBe("Exposure");
    expect(history).toHaveLength(2);
  });

  it("clamps exposure to ±5 EV rather than running to the strength range", async () => {
    const user = userEvent.setup();
    render(<BasicPanel />);
    await drag(user, screen.getByRole("slider", { name: "Exposure" }), TRACK_WIDTH * 4);
    expect(useDevelopStore.getState().params.exposure).toBe(5);

    await drag(user, screen.getByRole("slider", { name: "Exposure" }), -TRACK_WIDTH * 4);
    expect(useDevelopStore.getState().params.exposure).toBe(-5);
  });

  it("writes only the param the moved slider owns", async () => {
    const user = userEvent.setup();
    render(<BasicPanel />);
    await drag(user, screen.getByRole("slider", { name: "Contrast" }), TRACK_WIDTH / 2);

    const { params, history, historyIndex } = useDevelopStore.getState();
    expect(params.contrast).toBe(100);
    expect([params.exposure, params.highlights, params.saturation]).toEqual([0, 0, 0]);
    expect(history[historyIndex].label).toBe("Contrast");
  });

  it("resets a slider to its default on double-click", async () => {
    const user = userEvent.setup();
    render(<BasicPanel />);
    const clarity = screen.getByRole("slider", { name: "Clarity" });
    await drag(user, clarity, TRACK_WIDTH / 4);
    expect(useDevelopStore.getState().params.clarity).not.toBe(0);

    await user.dblClick(clarity);
    expect(useDevelopStore.getState().params.clarity).toBe(0);
  });
});

describe("Auto tone", () => {
  it("is inert until a histogram exists to measure", () => {
    render(<BasicPanel />);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Auto" }).disabled).toBe(
      true,
    );
  });

  it("becomes available once the renderer reports a histogram", () => {
    seedPhoto(HISTOGRAM);
    render(<BasicPanel />);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Auto" }).disabled).toBe(
      false,
    );
  });
});
