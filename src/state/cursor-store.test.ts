// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// @vitest-environment jsdom

// The cursor registry (token → CSS, extension overrides and their teardown) and
// the canvas-cursor request stack. The stack is only observable through
// useCanvasCursor, so those cases drive the real hook — that is the contract the
// Develop canvas depends on, including re-resolving when a request is released.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  BUILTIN_CURSORS,
  CURSOR_LABELS,
  clearExtensionCursors,
  contributionToSpec,
  registerCursor,
  resolveCursorCss,
  setCanvasCursor,
  useCanvasCursor,
  useCursorStore,
} from "./cursor-store";

// React only allows act() when the environment opts in; the auto-setup that
// normally does this is tied to test globals, which this project doesn't enable.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>';

interface ImageCursor {
  url: string;
  hotspot: string;
  fallback: string;
}

function parseImageCursor(css: string): ImageCursor {
  const m = /^url\("([^"]+)"\) (-?\d+ -?\d+), (.+)$/.exec(css);
  if (!m) throw new Error(`not an image cursor: ${css}`);
  return { url: m[1], hotspot: m[2], fallback: m[3] };
}

// The pristine store doubles as the reset baseline: the registry object is
// always rebuilt, never mutated in place.
const INITIAL = useCursorStore.getState();

const released: (() => void)[] = [];

/** Push a request the way a tool does, inside act() so the hook re-renders. */
function push(...args: Parameters<typeof setCanvasCursor>): () => void {
  let release = (): void => {};
  act(() => {
    release = setCanvasCursor(...args);
  });
  released.push(release);
  return release;
}

beforeEach(() => {
  useCursorStore.setState(INITIAL, true);
  released.length = 0;
});

afterEach(() => {
  for (const r of released) r();
});

describe("resolveCursorCss", () => {
  it("resolves built-in tokens to their CSS keyword", () => {
    expect(resolveCursorCss("pan")).toBe("grab");
    expect(resolveCursorCss("panning")).toBe("grabbing");
    expect(resolveCursorCss("crop-resize-nwse")).toBe("nwse-resize");
  });

  it("passes an unregistered string through as a raw CSS value", () => {
    // Callers may hand it a plain CSS cursor instead of a token.
    expect(resolveCursorCss("cell")).toBe("cell");
  });

  it("encodes inline SVG as a data URL with its hotspot and fallback", () => {
    const css = resolveCursorCss({
      image: SVG,
      hotspotX: 4,
      hotspotY: 6,
      fallback: "crosshair",
    });
    const { url, hotspot, fallback } = parseImageCursor(css);
    expect(hotspot).toBe("4 6");
    expect(fallback).toBe("crosshair");
    expect(url.startsWith("data:image/svg+xml,")).toBe(true);
    expect(decodeURIComponent(url.slice("data:image/svg+xml,".length))).toBe(SVG);
  });

  it("defaults an image cursor to a 0,0 hotspot and the auto fallback", () => {
    expect(parseImageCursor(resolveCursorCss({ image: SVG }))).toMatchObject({
      hotspot: "0 0",
      fallback: "auto",
    });
  });

  it("uses a non-SVG image reference verbatim", () => {
    const url = "https://example.test/cursor.png";
    expect(parseImageCursor(resolveCursorCss({ image: url })).url).toBe(url);
  });

  it("resolves the built-in sampling reticle centred on its ring", () => {
    const { hotspot, fallback } = parseImageCursor(resolveCursorCss("pick"));
    expect(hotspot).toBe("12 12");
    expect(fallback).toBe("crosshair");
  });

  it("names every token the user can interact with", () => {
    for (const id of Object.keys(CURSOR_LABELS)) {
      expect(BUILTIN_CURSORS[id]).toBeDefined();
    }
  });
});

describe("contributionToSpec", () => {
  it("prefers an explicit CSS keyword over an image", () => {
    expect(contributionToSpec({ id: "x", css: "move", image: SVG })).toEqual({
      css: "move",
    });
  });

  it("carries the hotspot and fallback through with an image", () => {
    expect(
      contributionToSpec({ id: "x", image: SVG, hotspotX: 2, fallback: "wait" }),
    ).toEqual({ image: SVG, hotspotX: 2, hotspotY: undefined, fallback: "wait" });
  });

  it("falls back to the default cursor when given neither", () => {
    expect(contributionToSpec({ id: "x" })).toEqual({ css: "default" });
  });
});

describe("extension cursor registry", () => {
  it("registers and then drops an extension-owned token", () => {
    registerCursor("my-ext", { id: "my-ext.measure", css: "col-resize" });
    expect(resolveCursorCss("my-ext.measure")).toBe("col-resize");

    clearExtensionCursors("my-ext");
    // No longer a token, so it falls through as a raw (meaningless) CSS value.
    expect(resolveCursorCss("my-ext.measure")).toBe("my-ext.measure");
  });

  it("restores the built-in when an extension that overrode it unloads", () => {
    const builtin = resolveCursorCss("pick");
    registerCursor("theme-ext", { id: "pick", css: "crosshair" });
    expect(resolveCursorCss("pick")).toBe("crosshair");

    clearExtensionCursors("theme-ext");
    expect(resolveCursorCss("pick")).toBe(builtin);
  });

  it("leaves other extensions' cursors alone", () => {
    registerCursor("ext-a", { id: "ext-a.tool", css: "cell" });
    registerCursor("ext-b", { id: "ext-b.tool", css: "text" });
    clearExtensionCursors("ext-a");
    expect(resolveCursorCss("ext-b.tool")).toBe("text");
  });
});

describe("canvas cursor stack", () => {
  it("is unset until something requests a cursor", () => {
    const { result, unmount } = renderHook(() => useCanvasCursor());
    expect(result.current).toBeNull();
    unmount();
  });

  it("resolves a token at request time and clears on release", () => {
    const { result, unmount } = renderHook(() => useCanvasCursor());
    const release = push("crop", "pan");
    expect(result.current).toBe("grab");

    act(() => release());
    expect(result.current).toBeNull();
    unmount();
  });

  it("accepts an inline spec and a raw CSS value", () => {
    const { result, unmount } = renderHook(() => useCanvasCursor());
    push("ext", { image: SVG, hotspotX: 1, hotspotY: 1 });
    expect(parseImageCursor(result.current ?? "").hotspot).toBe("1 1");

    push("ext", "cell");
    expect(result.current).toBe("cell");
    unmount();
  });

  it("lets the highest priority win regardless of push order", () => {
    const { result, unmount } = renderHook(() => useCanvasCursor());
    push("overlay", "crosshair", { priority: 50 });
    push("canvas", "pan", { priority: 10 });
    expect(result.current).toBe("crosshair");

    push("modal", "wait", { priority: 90 });
    expect(result.current).toBe("wait");
    unmount();
  });

  it("resolves equal priorities most-recent-first and restores on release", () => {
    const { result, unmount } = renderHook(() => useCanvasCursor());
    push("canvas", "pan");
    const releaseTool = push("tool", "crosshair");
    expect(result.current).toBe("crosshair");

    act(() => releaseTool());
    expect(result.current).toBe("grab");
    unmount();
  });

  it("keeps one slot per owner: re-requesting replaces, never stacks", () => {
    const { result, unmount } = renderHook(() => useCanvasCursor());
    push("tool", "pan");
    const release = push("tool", "crosshair");
    expect(useCursorStore.getState().requests).toHaveLength(1);

    act(() => release());
    expect(result.current).toBeNull();
    unmount();
  });

  it("re-resolves when a higher-priority request is released mid-stack", () => {
    const { result, unmount } = renderHook(() => useCanvasCursor());
    push("canvas", "pan", { priority: 10 });
    const releaseDrag = push("drag", "panning", { priority: 40 });
    push("hint", "zoom-in", { priority: 20 });
    expect(result.current).toBe("grabbing");

    act(() => releaseDrag());
    expect(result.current).toBe("zoom-in");
    unmount();
  });

  it("clears a request when passed null", () => {
    const { result, unmount } = renderHook(() => useCanvasCursor());
    push("tool", "pan");
    push("tool", null);
    expect(result.current).toBeNull();
    expect(useCursorStore.getState().requests).toEqual([]);
    unmount();
  });

  it("drops an extension's live request when it unloads", () => {
    const { result, unmount } = renderHook(() => useCanvasCursor());
    push("canvas", "pan", { priority: 10 });
    registerCursor("my-ext", { id: "my-ext.measure", css: "col-resize" });
    push("my-ext", "my-ext.measure", { priority: 30 });
    expect(result.current).toBe("col-resize");

    act(() => clearExtensionCursors("my-ext"));
    expect(result.current).toBe("grab");
    unmount();
  });
});
