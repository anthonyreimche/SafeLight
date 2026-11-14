// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it, vi } from "vitest";
import { halfBits } from "./half-float";
import { baseLuma, cutDetailGain, type NativeLuma } from "./native-frame";
import { NativeFrameHolder, type NativeCutWant } from "./native-frame-job";

function frame(width = 8, height = 6): NativeLuma {
  const data = new Uint16Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = halfBits(0.1 + ((i * 7) % 11) / 20);
  return { data, width, height };
}

const want = (key = "a"): NativeCutWant => ({ key, rect: { x: 0, y: 0, w: 1, h: 1 }, outW: 8, outH: 6, baseW: 4, baseH: 3 });

describe("NativeFrameHolder", () => {
  it("cuts the gain cutDetailGain gives from the frame held for the key, handing its buffer back", () => {
    const holder = new NativeFrameHolder();
    const held = frame();
    holder.handle({ op: "hold", key: "a", frame: held });
    const answer = holder.handle({ op: "cut", id: 3, want: want() });
    const expected = cutDetailGain(held, want().rect, 8, 6, 4, 3);
    if (!answer?.reply.gain || !expected) throw new Error("no gain");
    expect(answer.reply.id).toBe(3);
    expect([answer.reply.gain.width, answer.reply.gain.height]).toEqual([expected.width, expected.height]);
    expect(answer.reply.gain.rect).toEqual(expected.rect);
    let differing = 0;
    for (let i = 0; i < expected.data.length; i++) if (answer.reply.gain.data[i] !== expected.data[i]) differing++;
    expect(differing).toBe(0);
    expect(answer.transfer).toEqual([answer.reply.gain.data.buffer]);
  });

  it("answers null for a key it holds no frame for", () => {
    const holder = new NativeFrameHolder();
    expect(holder.handle({ op: "cut", id: 1, want: want() })?.reply).toEqual({ id: 1, gain: null });
    holder.handle({ op: "hold", key: "a", frame: frame() });
    expect(holder.handle({ op: "cut", id: 2, want: want("b") })?.reply).toEqual({ id: 2, gain: null });
  });

  it("replaces the frame on each hold", () => {
    const holder = new NativeFrameHolder();
    holder.handle({ op: "hold", key: "a", frame: frame() });
    holder.handle({ op: "hold", key: "b", frame: frame() });
    expect(holder.handle({ op: "cut", id: 1, want: want("a") })?.reply.gain).toBeNull();
    expect(holder.handle({ op: "cut", id: 2, want: want("b") })?.reply.gain).not.toBeNull();
  });

  it("drops the frame, or with a key only that photo's", () => {
    const holder = new NativeFrameHolder();
    holder.handle({ op: "hold", key: "a", frame: frame() });
    expect(holder.handle({ op: "drop", key: "b" })).toBeNull();
    expect(holder.handle({ op: "cut", id: 1, want: want() })?.reply.gain).not.toBeNull();
    holder.handle({ op: "drop", key: "a" });
    expect(holder.handle({ op: "cut", id: 2, want: want() })?.reply.gain).toBeNull();
    holder.handle({ op: "hold", key: "a", frame: frame() });
    holder.handle({ op: "drop" });
    expect(holder.handle({ op: "cut", id: 3, want: want() })?.reply.gain).toBeNull();
  });

  it("answers null when the cut is empty or throws", () => {
    const holder = new NativeFrameHolder();
    holder.handle({ op: "hold", key: "a", frame: frame() });
    expect(holder.handle({ op: "cut", id: 1, want: { ...want(), baseW: 8, baseH: 6 } })?.reply.gain).toBeNull();
    const failing = new NativeFrameHolder(() => {
      throw new Error("out of memory");
    });
    failing.handle({ op: "hold", key: "a", frame: frame() });
    expect(failing.handle({ op: "cut", id: 2, want: want() })?.reply).toEqual({ id: 2, gain: null });
  });
});

describe("NativeFrameHolder's base luminance", () => {
  it("works it out once for a frame and a base size, and again for another of either", () => {
    const baseOf = vi.fn(baseLuma);
    const holder = new NativeFrameHolder(cutDetailGain, baseOf);
    holder.handle({ op: "hold", key: "a", frame: frame() });
    holder.handle({ op: "cut", id: 1, want: want() });
    holder.handle({ op: "cut", id: 2, want: { ...want(), rect: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } } });
    expect(baseOf).toHaveBeenCalledTimes(1);

    holder.handle({ op: "cut", id: 3, want: { ...want(), baseW: 2, baseH: 2 } });
    expect(baseOf).toHaveBeenCalledTimes(2);

    holder.handle({ op: "hold", key: "a", frame: frame() });
    holder.handle({ op: "cut", id: 4, want: { ...want(), baseW: 2, baseH: 2 } });
    expect(baseOf).toHaveBeenCalledTimes(3);
  });

  it("hands the cut the luminance it holds", () => {
    const cut = vi.fn(cutDetailGain);
    const holder = new NativeFrameHolder(cut);
    const held = frame();
    holder.handle({ op: "hold", key: "a", frame: held });
    holder.handle({ op: "cut", id: 1, want: want() });
    const base = cut.mock.calls[0][6];
    expect(base?.length).toBe(4 * 3);
    expect(Array.from(base ?? [])).toEqual(Array.from(baseLuma(held, 4, 3) ?? []));
  });

  it("lets go of it with the frame", () => {
    const baseOf = vi.fn(baseLuma);
    const holder = new NativeFrameHolder(cutDetailGain, baseOf);
    holder.handle({ op: "hold", key: "a", frame: frame() });
    holder.handle({ op: "cut", id: 1, want: want() });
    holder.handle({ op: "drop" });
    holder.handle({ op: "hold", key: "a", frame: frame() });
    holder.handle({ op: "cut", id: 2, want: want() });
    expect(baseOf).toHaveBeenCalledTimes(2);
  });
});
