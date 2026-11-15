// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Develop shows a busy bar when the worker has drawn nothing for a render asked of it
// for half a second: a program being built after a stage is turned on or
// installed, or a slow software frame. A drag that keeps getting frames, however
// slowly, never shows it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerRequest } from "../render-protocol";
import type { RendererAvailability } from "../render-bridge";
import { RenderMailbox } from "./mailbox";
import type { WorkerLink } from "./transport";

type Render = Extract<WorkerRequest, { cmd: "render" }>;

class FakeLink implements WorkerLink {
  availability: RendererAvailability = "starting";
  disposed = false;
  heardAt = 0;
  posted: WorkerRequest[] = [];
  post(msg: WorkerRequest) {
    this.posted.push(msg);
  }
  lastRender(): Render {
    const last = this.posted.filter((m): m is Render => m.cmd === "render").at(-1);
    if (!last) throw new Error("no render posted");
    return last;
  }
}

let link: FakeLink;
let mailbox: RenderMailbox;
let seen: boolean[];

beforeEach(() => {
  vi.useFakeTimers();
  link = new FakeLink();
  mailbox = new RenderMailbox(link, () => undefined, () => false);
  seen = [];
  mailbox.setOnStall((stalled) => seen.push(stalled));
});

afterEach(() => {
  mailbox.clear();
  vi.useRealTimers();
});

describe("the render mailbox's stall", () => {
  it("is told once a render has had no frame for 500 ms, and cleared by its frame", () => {
    mailbox.render(false, false);
    vi.advanceTimersByTime(499);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([true]);

    mailbox.answered(link.lastRender().seq);
    expect(seen).toEqual([true, false]);
    vi.advanceTimersByTime(5_000);
    expect(seen).toEqual([true, false]);
  });

  it("is never told for a drag whose frames come every 400 ms", () => {
    for (let i = 0; i < 20; i++) {
      mailbox.render(false, false);
      vi.advanceTimersByTime(400);
      mailbox.render(false, false);
      mailbox.answered(link.lastRender().seq);
    }
    expect(seen).toEqual([]);
  });

  it("times the render waiting behind a frame from that frame", () => {
    mailbox.render(false, false);
    vi.advanceTimersByTime(400);
    mailbox.render(false, false);
    mailbox.answered(link.lastRender().seq);
    vi.advanceTimersByTime(499);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([true]);
  });

  // A software renderer drawing each frame of a drag in over 500 ms: shown once, the
  // bar stays until the worker has nothing left to draw, rather than flicker per frame.
  it("stays told through a slow drag's frames, and is cleared once nothing waits", () => {
    for (let i = 0; i < 5; i++) {
      mailbox.render(false, false);
      vi.advanceTimersByTime(600);
      mailbox.render(false, false);
      mailbox.answered(link.lastRender().seq);
    }
    expect(seen).toEqual([true]);

    vi.advanceTimersByTime(600);
    mailbox.answered(link.lastRender().seq);
    expect(seen).toEqual([true, false]);
  });

  it("is cleared when the mailbox is emptied", () => {
    mailbox.render(false, false);
    vi.advanceTimersByTime(600);
    mailbox.clear();
    expect(seen).toEqual([true, false]);
  });

  it("isn't timed with no one listening", () => {
    mailbox.setOnStall(null);
    mailbox.render(false, false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("names the last render posted", () => {
    expect(mailbox.lastSeq).toBe(0);
    mailbox.render(false, false);
    expect(mailbox.lastSeq).toBe(link.lastRender().seq);
    mailbox.render(false, false);
    expect(mailbox.lastSeq).toBe(link.lastRender().seq);
  });
});
