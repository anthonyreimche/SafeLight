// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What Re-import says when it ends: nothing when every photo was read again
// from disk, the photos it couldn't read, and for a library source's photos
// that their previews download again as they come into view.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/state/broadcast", () => ({
  broadcast: () => {},
  onBroadcast: () => () => {},
  WINDOW_ID: "test-window",
}));

import { reimportReport } from "./photo-actions";

describe("reimportReport", () => {
  it("says nothing when every photo was read again from disk", () => {
    expect(reimportReport({ ok: 3, failed: 0 })).toBeNull();
  });

  it("counts the photos it couldn't read, as before", () => {
    expect(reimportReport({ ok: 2, failed: 1 })).toBe("Re-imported 2 photos. 1 couldn't be read or decoded from disk.");
  });

  it("says a source's previews download again as they come into view", () => {
    expect(reimportReport({ ok: 1, failed: 0, refetched: 1 })).toBe(
      "Re-imported 1 photo from what its server lists now. Its preview downloads again when it comes into view.",
    );
    expect(reimportReport({ ok: 3, failed: 0, refetched: 3 })).toBe(
      "Re-imported 3 photos from what their server lists now. Their previews download again as they come into view.",
    );
  });
});
