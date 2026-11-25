// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// An extension's notices: bars in the bottom stack that it can update in
// place (a run's progress), that go by themselves once they only report, and
// that stay while they warn or a run is under way.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO_DISMISS_MS, dropNotifications, notify, useNotifications } from "./notification-store";
import { setExtensionName } from "@/extensions/param-registry";

const notices = () => useNotifications.getState().notices;

beforeEach(() => {
  vi.useFakeTimers();
  useNotifications.setState({ notices: [] });
  setExtensionName("acme.stack", "Stacking Tools");
});

afterEach(() => vi.useRealTimers());

describe("notify", () => {
  it("shows a message under the extension's name", () => {
    notify("acme.stack", "Merged 3 photos.");
    expect(notices()).toEqual([
      expect.objectContaining({ owner: "acme.stack", source: "Stacking Tools", message: "Merged 3 photos.", tone: "info", progress: null }),
    ]);
  });

  it("lets an info or success notice go by itself", () => {
    notify("acme.stack", { message: "Saved.", tone: "success" });
    vi.advanceTimersByTime(AUTO_DISMISS_MS - 1);
    expect(notices()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(notices()).toHaveLength(0);
  });

  it("keeps a warning or an error until it is dismissed", () => {
    notify("acme.stack", { message: "Saved without alignment.", tone: "warning" });
    notify("acme.stack", { message: "Merge failed.", tone: "error" });
    vi.advanceTimersByTime(AUTO_DISMISS_MS * 10);
    expect(notices().map((n) => n.tone)).toEqual(["warning", "error"]);
  });

  it("keeps a notice with progress, and lets it go once the run is done", () => {
    const run = notify("acme.stack", { message: "Aligning…", progress: 0.2 });
    vi.advanceTimersByTime(AUTO_DISMISS_MS * 2);
    run.update({ message: "Blending…", progress: 0.6 });
    expect(notices()[0]).toMatchObject({ message: "Blending…", progress: 0.6 });
    run.update({ message: "Merged.", tone: "success", progress: null });
    vi.advanceTimersByTime(AUTO_DISMISS_MS);
    expect(notices()).toHaveLength(0);
  });

  it("holds the value of progress to 0..1", () => {
    notify("acme.stack", { message: "Working", progress: 1.4 });
    expect(notices()[0].progress).toBe(1);
  });

  it("starts the wait again when a passing notice is updated", () => {
    const n = notify("acme.stack", "Exporting 1 of 3");
    vi.advanceTimersByTime(AUTO_DISMISS_MS - 10);
    n.update({ message: "Exporting 2 of 3" });
    vi.advanceTimersByTime(AUTO_DISMISS_MS - 10);
    expect(notices()).toHaveLength(1);
  });

  it("closes, and ignores updates once closed", () => {
    const n = notify("acme.stack", { message: "Working", tone: "warning" });
    n.close();
    n.update({ message: "Again" });
    expect(notices()).toEqual([]);
  });

  it("drops an extension's notices when it stops, and only its own", () => {
    notify("acme.stack", { message: "Mine", tone: "error" });
    notify("acme.other", { message: "Theirs", tone: "error" });
    dropNotifications("acme.stack");
    expect(notices().map((n) => n.message)).toEqual(["Theirs"]);
  });
});
