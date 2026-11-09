// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The native window controls take the colour of the top-most bar that asks
// for them, and go back to the bar underneath when a layer over it (the
// welcome setup over an open project) goes away.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, render } from "@testing-library/react";
import { useThemeStore } from "@/extensions/themes";
import { useSettings } from "@/state/settings-store";
import { useTitleBarOverlay } from "./window-chrome";

const SURFACE_0 = "#101010";
const SURFACE_1 = "#202020";
const TEXT = "#c0c0c0";

let setOverlay: Mock<(bg: string, fg: string, scale?: number) => Promise<void>>;
const themeBefore = useThemeStore.getState().activeId;
const scaleBefore = useSettings.getState().uiScale;

beforeEach(() => {
  setOverlay = vi.fn<(bg: string, fg: string, scale?: number) => Promise<void>>(async () => {});
  vi.stubGlobal("safelightNative", { titlebar: { setOverlay } });
  const root = document.documentElement.style;
  root.setProperty("--color-surface-0", SURFACE_0);
  root.setProperty("--color-surface-1", SURFACE_1);
  root.setProperty("--color-text-secondary", TEXT);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("style");
  useThemeStore.setState({ activeId: themeBefore });
  useSettings.setState({ uiScale: scaleBefore });
});

function Bar({ bgVar }: { bgVar: string }) {
  useTitleBarOverlay(bgVar);
  return null;
}

describe("useTitleBarOverlay", () => {
  it("gives the overlay back to the bar underneath when the top one unmounts", () => {
    render(<Bar bgVar="--color-surface-1" />);
    const layer = render(<Bar bgVar="--color-surface-0" />);
    expect(setOverlay).toHaveBeenLastCalledWith(SURFACE_0, TEXT, 1);
    layer.unmount();
    expect(setOverlay).toHaveBeenLastCalledWith(SURFACE_1, TEXT, 1);
  });

  it("leaves the later sibling on top when a theme change re-applies both", () => {
    render(
      <>
        <Bar bgVar="--color-surface-1" />
        <Bar bgVar="--color-surface-0" />
      </>,
    );
    act(() => useThemeStore.setState({ activeId: "test.other" }));
    expect(setOverlay).toHaveBeenLastCalledWith(SURFACE_0, TEXT, 1);
  });

  it("sends the Interface scale and republishes the inset when it changes", () => {
    render(<Bar bgVar="--color-surface-1" />);
    act(() => useSettings.setState({ uiScale: 1.5 }));
    expect(setOverlay).toHaveBeenLastCalledWith(SURFACE_1, TEXT, 1.5);
    expect(document.documentElement.style.getPropertyValue("--ui-scale")).toBe("1.5");
  });

  it.each([
    ["rgba(16, 32, 48, 0.5)", "#80102030"],
    ["rgb(16 32 48 / 50%)", "#80102030"],
    ["rgb(16, 32, 48)", "#102030"],
    ["#abc", "#abc"],
    ["#10203040", "#40102030"],
  ])("sends %s to the native overlay as hex", (css, hex) => {
    document.documentElement.style.setProperty("--color-surface-1", css);
    render(<Bar bgVar="--color-surface-1" />);
    expect(setOverlay).toHaveBeenLastCalledWith(hex, TEXT, 1);
  });
});
