// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What the native frame worker (native-frame-worker.ts) does with each message:
// hold the open photo's native luminance, let go of it, and cut detail gains from
// it. Kept apart from the worker so it runs, and is tested, without one.

import { baseLuma, cutDetailGain, type DetailGain, type FrameRect, type NativeLuma } from "./native-frame";

/** The cut a renderer wants: `rect` of the frame held for `key`, at most `outW` x
 *  `outH`, against a `baseW` x `baseH` base (cutDetailGain). */
export interface NativeCutWant {
  key: string;
  rect: FrameRect;
  outW: number;
  outH: number;
  baseW: number;
  baseH: number;
}

export type NativeFrameRequest =
  | { op: "hold"; key: string; frame: NativeLuma }
  | { op: "drop"; key?: string }
  | { op: "cut"; id: number; want: NativeCutWant };

/** The answer to cut `id`: null when no frame is held for its key, the cut is
 *  empty, or it failed. */
export interface NativeFrameReply {
  id: number;
  gain: DetailGain | null;
}

type Cut = typeof cutDetailGain;
type Base = typeof baseLuma;

export class NativeFrameHolder {
  private held: { key: string; frame: NativeLuma } | null = null;
  // The held frame's luminance at the base size its cuts are asked against:
  // every cut divides by it, and pans ask for cut after cut of one base.
  private base: { width: number; height: number; luma: Float32Array | null } | null = null;
  private readonly cut: Cut;
  private readonly baseOf: Base;

  constructor(cut: Cut = cutDetailGain, baseOf: Base = baseLuma) {
    this.cut = cut;
    this.baseOf = baseOf;
  }

  private baseFor(frame: NativeLuma, width: number, height: number): Float32Array | undefined {
    if (this.base?.width !== width || this.base.height !== height) {
      this.base = { width, height, luma: this.baseOf(frame, width, height) };
    }
    return this.base.luma ?? undefined;
  }

  /** The reply to `req` and the buffers that go with it; null for a request that
   *  is answered with nothing. */
  handle(req: NativeFrameRequest): { reply: NativeFrameReply; transfer: Transferable[] } | null {
    if (req.op === "hold") {
      this.held = { key: req.key, frame: req.frame };
      this.base = null;
      return null;
    }
    if (req.op === "drop") {
      if (req.key === undefined || req.key === this.held?.key) {
        this.held = null;
        this.base = null;
      }
      return null;
    }
    const { id, want } = req;
    const held = this.held;
    let gain: DetailGain | null = null;
    if (held && held.key === want.key) {
      try {
        const base = this.baseFor(held.frame, want.baseW, want.baseH);
        gain = this.cut(held.frame, want.rect, want.outW, want.outH, want.baseW, want.baseH, base);
      } catch (err) {
        console.error("[native-frame] detail cut failed:", err);
      }
    }
    return { reply: { id, gain }, transfer: gain ? [gain.data.buffer] : [] };
  }
}
