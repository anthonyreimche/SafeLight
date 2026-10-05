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
import { useTitleBarOverlay } from "./window-chrome";

const SURFACE_0 = "#101010";
const SURFACE_1 = "#202020";
const TEXT = "#c0c0c0";

let setOverlay: Mock<(bg: string, fg: string) => Promise<void>>;
const themeBefore = useThemeStore.getState().activeId;

beforeEach(() => {
  setOverlay = vi.fn<(bg: string, fg: string) => Promise<void>>(async () => {});
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
});

function Bar({ bgVar }: { bgVar: string }) {
  useTitleBarOverlay(bgVar);
  return null;
}

describe("useTitleBarOverlay", () => {
  it("gives the overlay back to the bar underneath when the top one unmounts", () => {
    render(<Bar bgVar="--color-surface-1" />);
    const layer = render(<Bar bgVar="--color-surface-0" />);
    expect(setOverlay).toHaveBeenLastCalledWith(SURFACE_0, TEXT);
    layer.unmount();
    expect(setOverlay).toHaveBeenLastCalledWith(SURFACE_1, TEXT);
  });

  it("leaves the later sibling on top when a theme change re-applies both", () => {
    render(
      <>
        <Bar bgVar="--color-surface-1" />
        <Bar bgVar="--color-surface-0" />
      </>,
    );
    act(() => useThemeStore.setState({ activeId: "test.other" }));
    expect(setOverlay).toHaveBeenLastCalledWith(SURFACE_0, TEXT);
  });
});
