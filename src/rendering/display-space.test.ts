// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// @vitest-environment jsdom

// The space the screen shows is P3 on a wide-gamut display and sRGB on any
// other, on Linux whatever the display (its monitor profile does that job), and
// wherever the browser can't say.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DisplaySpace } from "./color-space";
import { currentDisplaySpace, subscribeDisplaySpace } from "./display-space";

const P3_QUERY = "(color-gamut: p3)";

/** A screen whose gamut query can be flipped, and the listeners on it. */
let gamut: { matches: boolean; listeners: Set<() => void> };

// jsdom ships no matchMedia; only what display-space touches is real, hence the
// narrow cast.
function fakeMatchMedia(query: string): MediaQueryList {
  return {
    media: query,
    // Live, as a real MediaQueryList's is.
    get matches() {
      return query === P3_QUERY && gamut.matches;
    },
    addEventListener: (_type: string, fn: () => void) => void gamut.listeners.add(fn),
    removeEventListener: (_type: string, fn: () => void) => void gamut.listeners.delete(fn),
  } as unknown as MediaQueryList;
}

function onPlatform(platform: string) {
  vi.stubGlobal("safelightNative", { platform });
}

function moveToScreen(p3: boolean) {
  gamut.matches = p3;
  for (const fn of [...gamut.listeners]) fn();
}

beforeEach(() => {
  gamut = { matches: true, listeners: new Set() };
  vi.stubGlobal("matchMedia", fakeMatchMedia);
  onPlatform("win32");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("currentDisplaySpace", () => {
  it("is display-p3 when the screen is wide-gamut", () => {
    expect(currentDisplaySpace()).toBe("display-p3");
  });

  it("is srgb when it is not", () => {
    gamut.matches = false;
    expect(currentDisplaySpace()).toBe("srgb");
  });

  it("is srgb on Linux even when the query matches", () => {
    onPlatform("linux");
    expect(currentDisplaySpace()).toBe("srgb");
  });

  it("is srgb when the browser has no matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(currentDisplaySpace()).toBe("srgb");
  });
});

describe("subscribeDisplaySpace", () => {
  it("reports the new space when the screen changes, until unsubscribed", () => {
    gamut.matches = false;
    const seen: DisplaySpace[] = [];
    const stop = subscribeDisplaySpace((space) => seen.push(space));
    moveToScreen(true);
    moveToScreen(false);
    expect(seen).toEqual(["display-p3", "srgb"]);

    stop();
    moveToScreen(true);
    expect(seen).toEqual(["display-p3", "srgb"]);
    expect(gamut.listeners.size).toBe(0);
  });

  it("listens to nothing on Linux", () => {
    onPlatform("linux");
    subscribeDisplaySpace(() => undefined);
    expect(gamut.listeners.size).toBe(0);
  });

  it("can be called and stopped without matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(() => subscribeDisplaySpace(() => undefined)()).not.toThrow();
  });
});
