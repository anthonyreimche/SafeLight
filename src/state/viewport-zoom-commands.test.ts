// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it, vi } from "vitest";
import {
  registerViewportZoomCommands,
  viewportZoomCommands,
  type ViewportZoomCommands,
} from "./viewport-zoom-commands";

const commands = (): ViewportZoomCommands => ({
  zoomStep: vi.fn(),
  zoomFit: vi.fn(),
  zoom100: vi.fn(),
});

describe("viewport zoom commands", () => {
  it("has no target until a viewport registers", () => {
    expect(viewportZoomCommands()).toBeNull();
  });

  it("exposes the registered commands and clears on unregister", () => {
    const c = commands();
    const off = registerViewportZoomCommands(c);
    expect(viewportZoomCommands()).toBe(c);
    off();
    expect(viewportZoomCommands()).toBeNull();
  });

  it("the most recent registration wins and unregistering restores the previous", () => {
    const a = commands();
    const b = commands();
    const offA = registerViewportZoomCommands(a);
    const offB = registerViewportZoomCommands(b);
    expect(viewportZoomCommands()).toBe(b);
    offB();
    expect(viewportZoomCommands()).toBe(a);
    offA();
    expect(viewportZoomCommands()).toBeNull();
  });

  it("unregistering an older target leaves the active one in place", () => {
    const a = commands();
    const b = commands();
    const offA = registerViewportZoomCommands(a);
    const offB = registerViewportZoomCommands(b);
    offA();
    expect(viewportZoomCommands()).toBe(b);
    offB();
    expect(viewportZoomCommands()).toBeNull();
  });
});
