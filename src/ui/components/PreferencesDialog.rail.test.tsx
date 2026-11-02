// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The section rail's drag handle works in layout px, so a pointer delta under
// the Interface-scale zoom is divided by it; its saved width survives storage
// that throws.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { updateSettings } from "@/state/settings-store";
import { openPreferences, PreferencesDialog } from "./PreferencesDialog";

class SilentChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("BroadcastChannel", SilentChannel);
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  updateSettings({ uiScale: 1 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  updateSettings({ uiScale: 1 });
});

const railOf = () => {
  const handle = screen.getByTitle("Drag to resize");
  return { handle, rail: handle.previousElementSibling as HTMLElement };
};

const drag = (handle: HTMLElement, dx: number) => {
  fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 500 + dx, pointerId: 1 });
  fireEvent.pointerUp(handle, { clientX: 500 + dx, pointerId: 1 });
};

describe("Preferences section rail resize", () => {
  it("moves one layout px per cursor px at 100% scale", () => {
    render(<PreferencesDialog />);
    act(() => openPreferences("Interface"));
    const { handle, rail } = railOf();
    drag(handle, 50);
    expect(rail.style.width).toBe("194px");
  });

  it("divides the pointer delta by the UI zoom", () => {
    updateSettings({ uiScale: 1.25 });
    render(<PreferencesDialog />);
    act(() => openPreferences("Interface"));
    const { handle, rail } = railOf();
    drag(handle, 50);
    expect(rail.style.width).toBe("184px");
  });

  it.each(["pointerCancel", "lostPointerCapture"] as const)(
    "ends the drag on %s so later moves do not resize",
    (ending) => {
      render(<PreferencesDialog />);
      act(() => openPreferences("Interface"));
      const { handle, rail } = railOf();
      fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1 });
      fireEvent.pointerMove(handle, { clientX: 520, pointerId: 1 });
      fireEvent[ending](handle, { pointerId: 1 });
      fireEvent.pointerMove(handle, { clientX: 600, pointerId: 1 });
      expect(rail.style.width).toBe("164px");
    },
  );

  it("falls back to the default width when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<PreferencesDialog />);
    act(() => openPreferences("Interface"));
    const { handle, rail } = railOf();
    expect(rail.style.width).toBe("144px");
    expect(() => drag(handle, 20)).not.toThrow();
    expect(rail.style.width).toBe("164px");
  });
});
