// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The zoom quartet routes through the central rebindable-shortcut handler to
// whichever viewport is currently registered; with no viewport mounted the
// combos must fall through untouched (no preventDefault) so nothing swallows
// keys in modules without an image on screen.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { useKeyboardShortcuts } from "./use-keyboard-shortcuts";
import { useUIStore } from "@/state/ui-store";
import {
  registerViewportZoomCommands,
  type ViewportZoomCommands,
} from "@/state/viewport-zoom-commands";

function Harness() {
  useKeyboardShortcuts();
  return null;
}

function press(key: string): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, ctrlKey: true, cancelable: true });
  window.dispatchEvent(e);
  return e;
}

let off: (() => void) | null = null;
afterEach(() => {
  off?.();
  off = null;
});

function mountInDevelop(): ViewportZoomCommands {
  useUIStore.setState({ activeModule: "develop" });
  render(<Harness />);
  const commands: ViewportZoomCommands = {
    zoomStep: vi.fn(),
    zoomFit: vi.fn(),
    zoom100: vi.fn(),
  };
  off = registerViewportZoomCommands(commands);
  return commands;
}

describe("zoom shortcut dispatch", () => {
  it("routes the Photoshop quartet to the registered viewport", () => {
    const commands = mountInDevelop();
    expect(press("=").defaultPrevented).toBe(true);
    expect(commands.zoomStep).toHaveBeenLastCalledWith(1);
    press("-");
    expect(commands.zoomStep).toHaveBeenLastCalledWith(-1);
    press("0");
    expect(commands.zoomFit).toHaveBeenCalled();
    press("1");
    expect(commands.zoom100).toHaveBeenCalled();
  });

  it("lets the combos fall through when no viewport is registered", () => {
    useUIStore.setState({ activeModule: "develop" });
    render(<Harness />);
    expect(press("=").defaultPrevented).toBe(false);
    expect(press("0").defaultPrevented).toBe(false);
  });
});
