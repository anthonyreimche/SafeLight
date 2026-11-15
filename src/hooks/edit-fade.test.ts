// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A discrete edit (undo, a preset, a reset) eases the canvas into its look. The fade is
// armed when the edit lands and taken by the first frame drawn after it: a frame
// already on its way when the edit landed holds the look before, and fading into it
// would ease into the old picture and then cut to the new one.

import { describe, expect, it } from "vitest";
import { DISCRETE_FADE_MS, PREVIEW_FADE_MS, QUICK_REPEAT_MS, createEditFade } from "./edit-fade";

describe("the edit fade", () => {
  it("is not taken by a frame of a render posted before the edit", () => {
    const fade = createEditFade();
    expect(fade.discrete(7, 1000)).toBe(true);
    expect(fade.take(6)).toBeNull();
    expect(fade.take(7)).toBeNull();
  });

  it("is taken by the first frame after the edit, once", () => {
    const fade = createEditFade();
    fade.discrete(7, 1000);
    expect(fade.take(7)).toBeNull();
    expect(fade.take(8)).toBe(DISCRETE_FADE_MS);
    expect(fade.take(9)).toBeNull();
  });

  it("is cleared by a live write before its frame comes", () => {
    const fade = createEditFade();
    fade.discrete(7, 1000);
    fade.live();
    expect(fade.take(8)).toBeNull();
  });

  it("is not armed for a discrete edit within the quick-repeat window of the last", () => {
    const fade = createEditFade();
    expect(fade.discrete(1, 1000)).toBe(true);
    expect(fade.take(2)).toBe(DISCRETE_FADE_MS);

    // A held Ctrl+Z: each step cuts.
    expect(fade.discrete(2, 1000 + QUICK_REPEAT_MS - 1)).toBe(false);
    expect(fade.take(3)).toBeNull();
    expect(fade.discrete(3, 1000 + 2 * QUICK_REPEAT_MS - 2)).toBe(false);
    expect(fade.take(4)).toBeNull();

    // A step taken after a rest fades again.
    expect(fade.discrete(4, 1000 + 4 * QUICK_REPEAT_MS)).toBe(true);
    expect(fade.take(5)).toBe(DISCRETE_FADE_MS);
  });

  it("drops one still armed when a quick repeat lands before its frame", () => {
    const fade = createEditFade();
    fade.discrete(1, 1000);
    fade.discrete(1, 1050);
    expect(fade.take(2)).toBeNull();
  });

  it("arms the hover preview for the first frame after it, at its own length", () => {
    const fade = createEditFade();
    fade.preview(3);
    expect(fade.take(3)).toBeNull();
    expect(fade.take(4)).toBe(PREVIEW_FADE_MS);
  });

  it("is cleared when another photo, or the same one again, starts to load", () => {
    const fade = createEditFade();
    fade.discrete(1, 1000);
    fade.clear();
    expect(fade.take(2)).toBeNull();
  });
});
