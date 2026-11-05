// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// One extension at a time holds the canvas's pick-drag tool. Clearing is by
// owner, so one extension can't turn another's tool off, and an extension
// that goes away takes its tool with it.

import { afterEach, describe, expect, it } from "vitest";
import { unregisterExtension } from "@/extensions/registry";
import { setPickDrag, usePickDragStore, type PickDragTool } from "./pick-drag";

const tool = (): PickDragTool => ({ onDown: () => {}, onMove: () => {}, onUp: () => {} });
const held = () => usePickDragStore.getState().held;

afterEach(() => {
  usePickDragStore.setState({ held: null });
});

describe("setPickDrag", () => {
  it("holds the tool with its owner", () => {
    const t = tool();
    setPickDrag("acme", t);
    expect(held()).toEqual({ owner: "acme", tool: t });
  });

  it("hands the canvas to the last extension that set a tool", () => {
    setPickDrag("acme", tool());
    const other = tool();
    setPickDrag("other", other);
    expect(held()).toEqual({ owner: "other", tool: other });
  });

  it("clears only the owner's tool", () => {
    const t = tool();
    setPickDrag("acme", t);
    setPickDrag("other", null);
    expect(held()?.owner).toBe("acme");
    setPickDrag("acme", null);
    expect(held()).toBeNull();
  });

  it("drops the tool of an extension that goes away", () => {
    setPickDrag("acme", tool());
    unregisterExtension("acme");
    expect(held()).toBeNull();
  });
});
