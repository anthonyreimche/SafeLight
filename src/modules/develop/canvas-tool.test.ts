// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// One extension holds the canvas tool at a time; letting go takes only your
// own back; Escape tells the tool, then lets it go.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canvasToolAction,
  canvasToolWants,
  escapeCanvasTool,
  setCanvasTool,
  useCanvasToolStore,
  type CanvasTool,
} from "./canvas-tool";

const tool = (over: Partial<CanvasTool> = {}): CanvasTool => ({ overlay: () => null, ...over });
const held = () => useCanvasToolStore.getState().held;

afterEach(() => useCanvasToolStore.setState({ held: null }));

describe("the canvas tool", () => {
  it("is held by the last extension to set one", () => {
    const crop = tool();
    const guided = tool();
    setCanvasTool("safelight.crop", crop);
    setCanvasTool("safelight.transform", guided);
    expect(held()).toEqual({ owner: "safelight.transform", tool: guided });
  });

  it("lets go of the owner's tool only", () => {
    setCanvasTool("safelight.crop", tool());
    setCanvasTool("safelight.transform", null);
    expect(held()?.owner).toBe("safelight.crop");
    setCanvasTool("safelight.crop", null);
    expect(held()).toBeNull();
  });

  it("tells the tool about Escape, then lets it go", () => {
    const onEscape = vi.fn();
    setCanvasTool("safelight.crop", tool({ onEscape }));
    expect(escapeCanvasTool()).toBe(true);
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(held()).toBeNull();
    expect(escapeCanvasTool()).toBe(false);
  });
});

describe("a shortcut's action on the canvas tool", () => {
  it("goes to the held tool, which says whether it took it", () => {
    const onAction = vi.fn((action: string) => action === "brush.larger");
    setCanvasTool("safelight.heal", tool({ onAction }));
    expect(canvasToolAction("brush.larger")).toBe(true);
    expect(canvasToolAction("brush.featherUp")).toBe(false);
    expect(onAction).toHaveBeenCalledWith("brush.larger");
  });

  it("is left alone with no tool held, or one that takes no actions", () => {
    expect(canvasToolAction("brush.larger")).toBe(false);
    setCanvasTool("safelight.crop", tool());
    expect(canvasToolAction("brush.larger")).toBe(false);
  });
});

describe("whether the canvas tool wants an action", () => {
  it("asks the held tool without acting on it", () => {
    const onAction = vi.fn(() => true);
    setCanvasTool("safelight.masks", tool({ onAction, wants: (action) => action === "mask.delete" }));
    expect(canvasToolWants("mask.delete")).toBe(true);
    expect(canvasToolWants("brush.larger")).toBe(false);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("is no with no tool held, or one that says nothing", () => {
    expect(canvasToolWants("mask.delete")).toBe(false);
    setCanvasTool("safelight.crop", tool());
    expect(canvasToolWants("mask.delete")).toBe(false);
  });
});
