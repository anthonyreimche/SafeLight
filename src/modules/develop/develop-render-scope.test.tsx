// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Develop panels re-render only for the store state they draw. A catalog write
// for another photo, a histogram refresh (several a second while editing) or a
// slider tick must not re-render a panel that shows none of it. The second half
// pins what the narrower subscriptions must keep: panels still follow the open
// photo, and preset actions still capture the live edit.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { normalizeParams } from "@/catalog/types";
import { installMemoryStorage, photo } from "@/catalog/stored-edit.fixtures";
import { useCatalogStore } from "@/state/catalog-store";
import { useDevelopStore } from "@/state/develop-store";
import { usePresetsStore } from "@/state/presets-store";
import type { HistogramData } from "@/rendering/histogram";
import { CountRenders, renderCounts, resetRenderCounts } from "@/test/render-count.test-support";
import { BasicPanel } from "./panels/BasicPanel";
import { CropPanel } from "./panels/CropPanel";
import { PresetsPanel } from "./panels/PresetsPanel";
import { TransformPanel } from "./panels/TransformPanel";
import { WhiteBalancePanel } from "./panels/WhiteBalancePanel";

class SilentChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

// A commit regenerates the grid thumbnail through the render worker; this one
// never answers, so that background render simply never finishes.
class SilentWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  postMessage(): void {}
  terminate(): void {}
}

const TICKS = 30;
const INITIAL_CATALOG = useCatalogStore.getState();
const INITIAL_DEVELOP = useDevelopStore.getState();

const histogram = (seed: number): HistogramData => {
  const luma = new Uint32Array(256);
  luma[seed % 256] = 1000;
  return { r: luma.slice(), g: luma.slice(), b: luma.slice(), luma };
};

const rendersOf = (id: string) => renderCounts()[id] ?? 0;

function mount(panels: Record<string, ReactElement>) {
  render(
    <>
      {Object.entries(panels).map(([id, panel]) => (
        <CountRenders key={id} id={id}>
          {panel}
        </CountRenders>
      ))}
    </>,
  );
  resetRenderCounts();
}

beforeEach(() => {
  vi.stubGlobal("BroadcastChannel", SilentChannel);
  vi.stubGlobal("Worker", SilentWorker);
  installMemoryStorage();
  localStorage.clear();
  for (const title of ["Crop & Straighten", "Transform", "Presets"]) {
    localStorage.setItem(`sl_panel_${title}`, "1");
  }
  useCatalogStore.setState(INITIAL_CATALOG, true);
  useCatalogStore.setState({
    photos: [photo("A"), { ...photo("B"), width: 4000, height: 6000 }],
    activePhotoId: "A",
  });
  const params = normalizeParams(undefined);
  useDevelopStore.setState(INITIAL_DEVELOP, true);
  useDevelopStore.setState({
    photoId: "A",
    params,
    paramBag: {},
    history: [{ timestamp: 0, label: "Original", params, paramBag: {} }],
    historyIndex: 0,
  });
  usePresetsStore.setState({
    presets: [
      { id: "p1", name: "Bright", params: { exposure: 1 } },
      { id: "p2", name: "Punchy", params: { contrast: 30 } },
      { id: "p3", name: "Muted", params: { saturation: -40 }, group: "Looks" },
    ],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("render scope", () => {
  it("leaves Crop and Transform alone when another photo's record changes", () => {
    mount({ crop: <CropPanel />, transform: <TransformPanel /> });

    act(() => useCatalogStore.getState().updatePhoto({ ...photo("B"), rating: 3 }));

    expect.soft(rendersOf("crop")).toBe(0);
    expect.soft(rendersOf("transform")).toBe(0);
  });

  it("re-renders Basic and White Balance at most once over a run of histograms", () => {
    mount({ basic: <BasicPanel />, wb: <WhiteBalancePanel /> });

    for (let i = 0; i < TICKS; i++) {
      act(() => useDevelopStore.getState().setHistogram(histogram(i)));
    }

    expect.soft(rendersOf("basic")).toBeLessThanOrEqual(1);
    expect.soft(rendersOf("wb")).toBeLessThanOrEqual(1);
  });

  it("keeps Presets still while a slider moves", () => {
    mount({ presets: <PresetsPanel /> });

    for (let i = 1; i <= TICKS; i++) {
      act(() => useDevelopStore.getState().setParam("exposure", i / 10));
    }

    expect(rendersOf("presets")).toBe(0);
  });
});

describe("what the panels still follow", () => {
  const crop = () => useDevelopStore.getState().params.crop;

  it("enables Auto once a histogram arrives", () => {
    render(<BasicPanel />);
    const auto = screen.getByRole<HTMLButtonElement>("button", { name: "Auto" });
    expect(auto.disabled).toBe(true);

    act(() => useDevelopStore.getState().setHistogram(histogram(0)));
    expect(auto.disabled).toBe(false);

    act(() => useDevelopStore.getState().setHistogram(null));
    expect(auto.disabled).toBe(true);
  });

  it("sizes a Crop aspect for the open photo, across a switch and a rotate", async () => {
    const user = userEvent.setup();
    render(<CropPanel />);
    await user.click(screen.getByRole("button", { name: "Crop" }));

    await user.click(screen.getByRole("button", { name: "1:1" }));
    expect(crop()).toMatchObject({ width: 4000 / 6000, height: 1 });

    act(() => useCatalogStore.getState().setActivePhoto("B"));
    await user.click(screen.getByRole("button", { name: "1:1" }));
    expect(crop()).toMatchObject({ width: 1, height: 4000 / 6000 });

    await act(() => useCatalogStore.getState().rotatePhotos(["B"], 90));
    await user.click(screen.getByRole("button", { name: "1:1" }));
    expect(crop()).toMatchObject({ width: 4000 / 6000, height: 1 });
  });

  it("fits the Transform crop to the open photo, across a switch and a rotate", async () => {
    useDevelopStore.setState({ cropAspect: 1, constrainCrop: true });
    const user = userEvent.setup();
    render(<TransformPanel />);
    const off = screen.getByRole("button", { name: "Off" });

    await user.click(off);
    expect(crop().width).toBeCloseTo(4000 / 6000);
    expect(crop().height).toBeCloseTo(1);

    act(() => useCatalogStore.getState().setActivePhoto("B"));
    await user.click(off);
    expect(crop().width).toBeCloseTo(1);
    expect(crop().height).toBeCloseTo(4000 / 6000);

    await act(() => useCatalogStore.getState().rotatePhotos(["B"], 90));
    await user.click(off);
    expect(crop().width).toBeCloseTo(4000 / 6000);
    expect(crop().height).toBeCloseTo(1);
  });
});

describe("presets capture the live edit", () => {
  const exposure = 1.3;
  const tick = () =>
    act(() => {
      useDevelopStore.getState().setParam("exposure", exposure);
      useDevelopStore.getState().setParam("contrast", 25);
    });

  it("saves the live params from the Save dialog", async () => {
    const user = userEvent.setup();
    render(<PresetsPanel />);
    tick();

    await user.click(screen.getByRole("button", { name: "Save preset…" }));
    await user.type(screen.getByRole("textbox", { name: "Preset name" }), "Live");
    await user.click(screen.getByRole("button", { name: "Save preset" }));

    const saved = usePresetsStore.getState().presets.find((p) => p.name === "Live");
    expect(saved?.params).toMatchObject({ exposure, contrast: 25 });
  });

  it("updates a preset with the live params", async () => {
    const user = userEvent.setup();
    render(<PresetsPanel />);
    tick();

    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: "Bright" }) });
    await user.click(screen.getByRole("menuitem", { name: "Update with current settings" }));
    await user.click(screen.getByRole("button", { name: "Update preset" }));

    const updated = usePresetsStore.getState().presets.find((p) => p.id === "p1");
    expect(updated?.params).toMatchObject({ exposure, contrast: 25 });
  });

  it("applies a partial preset over the live params", async () => {
    const user = userEvent.setup();
    render(<PresetsPanel />);
    tick();

    await user.click(screen.getByRole("button", { name: "Muted" }));

    expect(useDevelopStore.getState().params).toMatchObject({
      exposure,
      contrast: 25,
      saturation: -40,
    });
  });

  it("exports the live params", async () => {
    // The export downloads through an anchor; jsdom has no object URLs, and the
    // Blob handed to createObjectURL is the preset file.
    const written: Blob[] = [];
    class CapturingURL extends URL {
      static createObjectURL(obj: Blob | MediaSource): string {
        if (obj instanceof Blob) written.push(obj);
        return "blob:preset";
      }
      static revokeObjectURL(): void {}
    }
    vi.stubGlobal("URL", CapturingURL);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const user = userEvent.setup();
    render(<PresetsPanel />);
    tick();

    await user.click(screen.getByRole("button", { name: "Export" }));

    expect(written).toHaveLength(1);
    const file: unknown = JSON.parse(await written[0].text());
    expect(file).toMatchObject({ params: { exposure, contrast: 25 } });
  });
});
