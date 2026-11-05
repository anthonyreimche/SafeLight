// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// One extension holds the canvas tool at a time; letting go takes only your
// own back; Escape tells the tool, then lets it go.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { DevelopParams } from "@/catalog/types";
import {
  canvasToolAction,
  canvasToolView,
  canvasToolWants,
  escapeCanvasTool,
  setCanvasTool,
  useCanvasToolStore,
  type CanvasTool,
} from "./canvas-tool";
import { CALLBACK_FAILURE_LIMIT, forgetCallbackFailures, useCallbackFailures } from "@/extensions/guard";

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

describe("the held tool's view of the edit", () => {
  it("is none with no tool held, or one with no view", () => {
    expect(canvasToolView(held())).toBeNull();
    setCanvasTool("safelight.crop", tool());
    expect(canvasToolView(held())).toBeNull();
  });

  it("calls the tool's viewParams on the tool, through one function per tool", () => {
    const crop = {
      overlay: () => null,
      wide: { x: 0, y: 0, width: 1, height: 1 },
      viewParams(this: { wide: DevelopParams["crop"] }, p: DevelopParams): DevelopParams {
        return { ...p, crop: this.wide };
      },
    };
    setCanvasTool("safelight.crop", crop);
    const view = canvasToolView(held());
    expect(view?.({ exposure: 0 } as DevelopParams).crop).toBe(crop.wide);
    expect(canvasToolView(held())).toBe(view);
  });
});

describe("a canvas tool that throws", () => {
  const boom = () => {
    throw new Error("broken tool");
  };

  it("is still let go on Escape", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    setCanvasTool("acme.broken", tool({ onEscape: boom }));
    expect(escapeCanvasTool()).toBe(true);
    expect(held()).toBeNull();
  });

  it("leaves a shortcut's action to core", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    setCanvasTool("acme.broken", tool({ onAction: boom, wants: boom }));
    expect(canvasToolAction("brush.larger")).toBe(false);
    expect(canvasToolWants("brush.larger")).toBe(false);
  });

  it("leaves the live view drawing the edit as it is", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    setCanvasTool("acme.broken", tool({ viewParams: boom }));
    const params = { exposure: 1 } as DevelopParams;
    expect(canvasToolView(held())?.(params)).toBe(params);
  });

  it("is switched off after repeated throws and listed against its extension", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onAction = vi.fn(boom);
    setCanvasTool("acme.broken", tool({ onAction }));
    try {
      for (let i = 0; i <= CALLBACK_FAILURE_LIMIT; i++) canvasToolAction("brush.larger");
      expect(onAction).toHaveBeenCalledTimes(CALLBACK_FAILURE_LIMIT);
      expect(useCallbackFailures.getState()["acme.broken"]?.kind).toBe("canvas tool action");
    } finally {
      forgetCallbackFailures("acme.broken");
    }
  });
});
