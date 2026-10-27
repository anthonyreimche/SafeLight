// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Copy Settings fills a clipboard that Paste fans out over whole selections, so
// what the dialog hands back has to be exactly the ticked rows — no more. The
// per-image rows (framing, heal spots) are the ones that would do damage if they
// rode along uninvited.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { normalizeParams, type RetouchSpot } from "@/catalog/types";
import { normalizeParamBag } from "@/extensions/param-registry";
import { DEFAULT_PIPELINE, usePipelineStore } from "@/extensions/pipelines";
import { registerPipeline, unregisterExtension, useRegistry } from "@/extensions/registry";
import type { DevelopClipboard } from "@/state/develop-clipboard";
import { CopySettingsDialog } from "./CopySettingsDialog";

const SPOT: RetouchSpot = {
  id: "spot-1",
  shape: "circle",
  mode: "heal",
  visible: true,
  dstX: 0.5,
  dstY: 0.5,
  srcX: 0.4,
  srcY: 0.4,
  radius: 0.04,
  feather: 50,
  opacity: 100,
};

function setup(
  overrides: Parameters<typeof normalizeParams>[0] = {},
  paramBag: Record<string, unknown> = {},
) {
  const onCopy = vi.fn<(clip: DevelopClipboard) => void>();
  const onCancel = vi.fn();
  const view = render(
    <CopySettingsDialog
      params={normalizeParams(overrides)}
      paramBag={paramBag}
      sourceName="IMG_0001.NEF"
      onCopy={onCopy}
      onCancel={onCancel}
    />,
  );
  return {
    ...view,
    onCopy,
    onCancel,
    user: userEvent.setup(),
    copy: screen.getByRole<HTMLButtonElement>("button", { name: "Copy" }),
  };
}

const box = (name: RegExp) => screen.getByRole<HTMLInputElement>("checkbox", { name });
const copied = (onCopy: Mock<(clip: DevelopClipboard) => void>) =>
  onCopy.mock.calls[0][0];

describe("what the clipboard carries", () => {
  it("starts from the changed global adjustments", async () => {
    const { user, copy, onCopy } = setup({ exposure: 1.2, contrast: 30 });
    await user.click(copy);
    expect(Object.keys(copied(onCopy).params).sort()).toEqual(["contrast", "exposure"]);
    expect(copied(onCopy).fieldCount).toBe(2);
  });

  it("drops a group as soon as its box is cleared", async () => {
    const { user, copy, onCopy } = setup({ exposure: 1.2, contrast: 30 });
    await user.click(box(/^Contrast/));
    await user.click(copy);
    expect(copied(onCopy).params).toEqual({ exposure: 1.2 });
    expect(copied(onCopy).fieldCount).toBe(1);
  });

  it("names the source photo it was copied from", async () => {
    const { user, copy, onCopy } = setup({ exposure: 1.2 });
    expect(screen.getByText(/IMG_0001\.NEF/)).toBeTruthy();
    await user.click(copy);
    expect(copied(onCopy).sourceName).toBe("IMG_0001.NEF");
  });

  it("refuses to copy nothing", async () => {
    const { user, copy, onCopy } = setup({ exposure: 1.2 });
    await user.click(box(/^Exposure/));
    expect(copy.disabled).toBe(true);
    await user.click(copy);
    expect(onCopy).not.toHaveBeenCalled();
  });
});

describe("per-image edits", () => {
  const perImage = { exposure: 1.2, retouch: [SPOT], crop: { x: 0.1, y: 0, width: 0.5, height: 1 } };

  it("lists framing and heal spots but never pre-selects them", async () => {
    const { user, copy, onCopy } = setup(perImage);
    expect(box(/^Crop & transform/).checked).toBe(false);
    expect(box(/^Retouch/).checked).toBe(false);

    await user.click(copy);
    expect(Object.keys(copied(onCopy).params)).toEqual(["exposure"]);
  });

  it("carries them once they are ticked on purpose", async () => {
    const { user, copy, onCopy } = setup(perImage);
    await user.click(box(/^Retouch/));
    await user.click(copy);
    expect(copied(onCopy).params.retouch?.map((s) => s.id)).toEqual([SPOT.id]);
  });
});

describe("extension stages", () => {
  it("offers no row when the photo has no stage params", () => {
    setup({ exposure: 1.2 });
    expect(screen.queryByRole("checkbox", { name: /Extension stages/ })).toBeNull();
  });

  it("copies the bag by value so later edits can't reach the clipboard", async () => {
    const bag = { "film.stock": "portra", "film.grain": 40 };
    const { user, copy, onCopy } = setup({ exposure: 1.2 }, bag);
    expect(box(/Extension stages/).checked).toBe(true);

    await user.click(copy);
    expect(copied(onCopy).paramBag).toEqual(bag);
    expect(copied(onCopy).paramBag).not.toBe(bag);
  });

  it("leaves the bag empty when the row is cleared", async () => {
    const { user, copy, onCopy } = setup({ exposure: 1.2 }, { "film.stock": "portra" });
    await user.click(box(/Extension stages/));
    await user.click(copy);
    expect(copied(onCopy).paramBag).toEqual({});
    expect(copied(onCopy).fieldCount).toBe(1);
  });
});

describe("Show all", () => {
  it("says so when an untouched photo has nothing to offer", () => {
    const { copy } = setup();
    expect(screen.getByText(/No adjustments on this photo/i)).toBeTruthy();
    expect(copy.disabled).toBe(true);
  });

  it("reveals the untouched adjustments without selecting any of them", async () => {
    const { user, copy, onCopy } = setup();
    await user.click(screen.getByRole("checkbox", { name: "Show all" }));

    const revealed = screen
      .getAllByRole<HTMLInputElement>("checkbox")
      .filter((c) => c !== screen.getByRole("checkbox", { name: "Show all" }));
    expect(revealed.length).toBeGreaterThan(0);
    expect(revealed.some((c) => c.checked)).toBe(false);
    expect(copy.disabled).toBe(true);

    await user.click(box(/^Vibrance/));
    await user.click(copy);
    expect(copied(onCopy).params).toEqual({ vibrance: 0 });
  });
});

describe("dismissing", () => {
  it("cancels from the Cancel button", async () => {
    const { user, onCancel, onCopy } = setup({ exposure: 1.2 });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCopy).not.toHaveBeenCalled();
  });

  it("cancels on a click outside the card but not inside it", async () => {
    // The backdrop is the dialog's own root element; only a click that lands on
    // it (rather than bubbling from the card) dismisses.
    const { user, container, onCancel } = setup({ exposure: 1.2 });
    await user.click(box(/^Exposure/));
    expect(onCancel).not.toHaveBeenCalled();

    await user.click(container.firstElementChild as HTMLElement);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("display transform", () => {
  it("pre-selects a photo's own pick and copies it", async () => {
    const { user, copy, onCopy } = setup({ displayTransform: "rendering.agx" });
    expect(box(/^Display transform/).checked).toBe(true);
    await user.click(copy);
    expect(copied(onCopy).params).toEqual({ displayTransform: "rendering.agx" });
  });

  it("copies 'follow the default' once ticked on a photo without a pick", async () => {
    const { user, copy, onCopy } = setup({ exposure: 1.2 });
    await user.click(screen.getByRole("checkbox", { name: "Show all" }));
    await user.click(box(/^Display transform/));
    await user.click(copy);
    expect(copied(onCopy).params).toEqual({ exposure: 1.2, displayTransform: null });
  });
});

describe("a display transform with settings", () => {
  beforeEach(() => {
    useRegistry.setState({ pipelines: {} });
    registerPipeline("test", {
      id: "test.tuned",
      name: "Tuned",
      glsl: "vec3 pipelineToDisplay(vec3 lin) { return gain * lin; }",
      params: [{ key: "gain", glslType: "float", default: 1 }],
    });
  });

  afterEach(() => {
    unregisterExtension("test");
    usePipelineStore.setState({ activeId: DEFAULT_PIPELINE });
  });

  const BAG = { "test.tuned.gain": 2, "other.stage.x": 1 };

  it("copies the transform's settings with the pick, without the other extension stages", async () => {
    const { user, copy, onCopy } = setup({ displayTransform: "test.tuned" }, BAG);
    await user.click(box(/^Extension stages/));
    await user.click(copy);
    expect(copied(onCopy).params).toEqual({ displayTransform: "test.tuned" });
    expect(copied(onCopy).paramBag).toEqual({ "test.tuned.gain": 2 });
  });

  it("copies an empty bag with both rows cleared", async () => {
    const { user, copy, onCopy } = setup({ exposure: 1.2, displayTransform: "test.tuned" }, BAG);
    await user.click(box(/^Display transform/));
    await user.click(box(/^Extension stages/));
    await user.click(copy);
    expect(copied(onCopy).params).toEqual({ exposure: 1.2 });
    expect(copied(onCopy).paramBag).toEqual({});
  });

  it("copies the whole bag with Extension stages ticked and the Display transform row cleared", async () => {
    const { user, copy, onCopy } = setup({ exposure: 1.2, displayTransform: "test.tuned" }, BAG);
    await user.click(box(/^Display transform/));
    await user.click(copy);
    expect(copied(onCopy).params).toEqual({ exposure: 1.2 });
    expect(copied(onCopy).paramBag).toEqual(BAG);
  });

  // Paste merges the clipboard's bag over each target's, so a setting left out
  // would keep a tuned target's own value.
  describe("on a photo that never moved the transform's settings", () => {
    const UNTOUCHED = { "other.stage.x": 1 };
    const pasted = (onCopy: Mock<(clip: DevelopClipboard) => void>) => ({
      "test.tuned.gain": 3,
      "other.stage.x": 5,
      ...normalizeParamBag(copied(onCopy).paramBag),
    });

    it("copies each setting as its default, so a paste resets a tuned target", async () => {
      const { user, copy, onCopy } = setup({ displayTransform: "test.tuned" }, UNTOUCHED);
      await user.click(box(/^Extension stages/));
      await user.click(copy);
      expect(copied(onCopy).paramBag).toEqual({ "test.tuned.gain": 1 });
      expect(pasted(onCopy)).toEqual({ "test.tuned.gain": 1, "other.stage.x": 5 });
    });

    it("adds the defaults to the whole bag when both rows are ticked", async () => {
      const { user, copy, onCopy } = setup({ displayTransform: "test.tuned" }, UNTOUCHED);
      await user.click(copy);
      expect(copied(onCopy).paramBag).toEqual({ "other.stage.x": 1, "test.tuned.gain": 1 });
      expect(pasted(onCopy)).toEqual({ "test.tuned.gain": 1, "other.stage.x": 1 });
    });
  });

  // The Extension stages row already carries the settings of the transform a
  // photo without a pick follows; a ticked Display transform row would add only
  // "follow the default", resetting every paste target's own pick.
  describe("on a photo without a pick", () => {
    beforeEach(() => usePipelineStore.setState({ activeId: "test.tuned" }));

    it("leaves the Display transform row unticked though a setting of the default transform moved", async () => {
      const { user, copy, onCopy } = setup({}, BAG);
      await user.click(screen.getByRole("checkbox", { name: "Show all" }));
      expect(box(/^Display transform/).checked).toBe(false);
      await user.click(copy);
      expect(copied(onCopy).params).toEqual({});
      expect(copied(onCopy).paramBag).toEqual(BAG);
    });

    it("copies 'follow the default' and the transform's settings once ticked", async () => {
      const { user, copy, onCopy } = setup({}, BAG);
      await user.click(screen.getByRole("checkbox", { name: "Show all" }));
      await user.click(box(/^Display transform/));
      await user.click(box(/^Extension stages/));
      await user.click(copy);
      expect(copied(onCopy).params).toEqual({ displayTransform: null });
      expect(copied(onCopy).paramBag).toEqual({ "test.tuned.gain": 2 });
    });
  });
});
