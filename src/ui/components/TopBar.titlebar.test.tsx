// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The top bar is the window title bar: at every platform and Interface scale
// the native controls match the bar's height and the bar leaves room for them.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const BAR_HEIGHT = 38;
const OVERLAY_WIDTH = 138; // Windows/Linux min/max/close
const TRAFFIC_LIGHTS_WIDTH = 78; // macOS

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("style");
  vi.resetModules();
});

async function renderBar(platform: string, uiScale: number) {
  vi.resetModules();
  const setOverlay = vi.fn(async () => {});
  vi.stubGlobal("safelightNative", { platform, titlebar: { setOverlay } });
  document.documentElement.style.setProperty("--color-surface-1", "#222");
  document.documentElement.style.setProperty("--color-text-secondary", "#ccc");
  const { useSettings } = await import("@/state/settings-store");
  useSettings.setState({ uiScale });
  const { TopBar } = await import("./TopBar");
  const { container } = render(<TopBar />);
  const bar = container.firstElementChild as HTMLElement;
  return { bar, setOverlay };
}

// A length in CSS px as it lands on screen: the body zoom multiplies it.
function onScreen(length: string, uiScale: number): number {
  const px = Number(/calc\((\d+)px \/ var\(--ui-scale/.exec(length)?.[1]);
  return (px / uiScale) * uiScale;
}

describe.each(["win32", "linux", "darwin"])("TopBar on %s", (platform) => {
  it.each([0.8, 0.9, 1, 1.25, 1.5, 2])("tracks the controls at scale %s", async (uiScale) => {
    const { bar, setOverlay } = await renderBar(platform, uiScale);

    expect(setOverlay).toHaveBeenLastCalledWith("#222", "#ccc", uiScale);
    expect(document.documentElement.style.getPropertyValue("--ui-scale")).toBe(String(uiScale));

    // The overlay is 36 of the bar's 38 CSS px, both scaled by the same zoom.
    const overlayHeight = Math.round(36 * uiScale);
    expect(overlayHeight).toBeLessThanOrEqual(BAR_HEIGHT * uiScale);
    expect(overlayHeight).toBeGreaterThan(BAR_HEIGHT * uiScale - 3 * uiScale);

    const inset = platform === "darwin" ? bar.style.paddingLeft : bar.style.paddingRight;
    const width = platform === "darwin" ? TRAFFIC_LIGHTS_WIDTH : OVERLAY_WIDTH;
    expect(onScreen(inset, uiScale)).toBeGreaterThanOrEqual(width);
  });
});
