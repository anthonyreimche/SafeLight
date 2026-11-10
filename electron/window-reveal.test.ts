// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Windows open hidden and show on ready-to-show, which never comes on some
// systems: under software rendering or a Wayland session Chromium may never
// paint a hidden window, and Safelight seemed not to start at all
// (window-reveal.cjs).

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOAD_GRACE_MS, OPEN_GRACE_MS, revealWhenReady } from "./window-reveal.cjs";

class FakeWindow extends EventEmitter {
  destroyed = false;
  webContents = new EventEmitter();
  isDestroyed() {
    return this.destroyed;
  }
}

describe("revealWhenReady", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows on ready-to-show", () => {
    const win = new FakeWindow();
    const show = vi.fn();
    revealWhenReady(win, show);
    win.emit("ready-to-show");
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("shows a loaded page that never reports ready-to-show", () => {
    const win = new FakeWindow();
    const show = vi.fn();
    revealWhenReady(win, show);
    win.webContents.emit("did-finish-load");
    vi.advanceTimersByTime(LOAD_GRACE_MS - 1);
    expect(show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("shows the window even when the page never reports anything", () => {
    const win = new FakeWindow();
    const show = vi.fn();
    revealWhenReady(win, show);
    vi.advanceTimersByTime(OPEN_GRACE_MS);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("shows once, whichever comes first", () => {
    const win = new FakeWindow();
    const show = vi.fn();
    revealWhenReady(win, show);
    win.webContents.emit("did-finish-load");
    win.emit("ready-to-show");
    vi.advanceTimersByTime(OPEN_GRACE_MS * 2);
    win.emit("ready-to-show");
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("leaves a window closed before it showed alone", () => {
    const win = new FakeWindow();
    const show = vi.fn();
    revealWhenReady(win, show);
    win.destroyed = true;
    win.emit("closed");
    vi.advanceTimersByTime(OPEN_GRACE_MS * 2);
    expect(show).not.toHaveBeenCalled();
  });

  it("says when it had to show the window without ready-to-show", () => {
    const win = new FakeWindow();
    revealWhenReady(win, () => {});
    vi.advanceTimersByTime(OPEN_GRACE_MS);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("ready-to-show"));
  });
});
