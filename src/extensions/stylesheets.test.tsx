// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Extension stylesheets: the registry entry plus the per-window sink that keeps
// the document in step with it. jsdom has no adoptedStyleSheets, so the real
// document exercises the <style> fallback; the constructed-sheet path runs
// against a stub document with a fake CSSStyleSheet. Lives in the dom project
// (.test.tsx) because the sink needs a real <head>.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerStylesheet,
  unregisterExtension,
  unregisterStylesheet,
  useRegistry,
} from "./registry";
import { initStylesheets, syncStylesheets } from "./stylesheets";

const EXT = "acme.style";
const OTHER = "other.ext";
const A = ".a{color:red}";
const B = ".b{color:blue}";
const C = ".c{color:green}";

const sheets = () => useRegistry.getState().stylesheets;
const styleEls = () =>
  Array.from(
    document.head.querySelectorAll<HTMLStyleElement>("style[data-sl-stylesheet]"),
  );
const ids = () => styleEls().map((el) => el.getAttribute("data-sl-stylesheet"));

beforeEach(() => {
  useRegistry.setState({ stylesheets: {} });
  for (const el of styleEls()) el.remove();
});

describe("registry", () => {
  it("tags a registered stylesheet with its extension id", () => {
    registerStylesheet(EXT, { id: "a", css: A });
    expect(sheets().a).toEqual({ id: "a", css: A, extensionId: EXT });
  });

  it("re-registering the same id replaces the CSS", () => {
    registerStylesheet(EXT, { id: "a", css: A });
    registerStylesheet(EXT, { id: "a", css: B });
    expect(sheets().a.css).toBe(B);
  });

  it("only the owning extension can unregister a stylesheet", () => {
    registerStylesheet(EXT, { id: "a", css: A });
    unregisterStylesheet(OTHER, "a");
    expect(sheets().a).toBeDefined();
    unregisterStylesheet(EXT, "a");
    expect(sheets().a).toBeUndefined();
  });

  it("unregisterExtension sweeps only that extension's stylesheets", () => {
    registerStylesheet(EXT, { id: "a", css: A });
    registerStylesheet(OTHER, { id: "b", css: B });
    unregisterExtension(EXT);
    expect(Object.keys(sheets())).toEqual(["b"]);
  });
});

describe("<style> fallback", () => {
  it("creates one element per contribution, in registration order, holding the CSS", () => {
    registerStylesheet(EXT, { id: "a", css: A });
    registerStylesheet(OTHER, { id: "b", css: B });
    syncStylesheets(sheets());
    expect(ids()).toEqual(["a", "b"]);
    expect(styleEls()[0].textContent).toBe(A);
  });

  it("updates a re-registered sheet in place and keeps its position", () => {
    registerStylesheet(EXT, { id: "a", css: A });
    registerStylesheet(OTHER, { id: "b", css: B });
    syncStylesheets(sheets());
    const first = styleEls()[0];
    registerStylesheet(EXT, { id: "a", css: C });
    syncStylesheets(sheets());
    expect(styleEls()[0]).toBe(first);
    expect(first.textContent).toBe(C);
    expect(ids()).toEqual(["a", "b"]);
  });

  it("removes the element of an unregistered sheet", () => {
    registerStylesheet(EXT, { id: "a", css: A });
    syncStylesheets(sheets());
    unregisterStylesheet(EXT, "a");
    syncStylesheets(sheets());
    expect(ids()).toEqual([]);
  });

  it("keeps extension sheets after any style element already in <head>", () => {
    const core = document.createElement("style");
    document.head.appendChild(core);
    try {
      registerStylesheet(EXT, { id: "a", css: A });
      syncStylesheets(sheets());
      expect(core.nextElementSibling).toBe(styleEls()[0]);
    } finally {
      core.remove();
    }
  });
});

describe("initStylesheets", () => {
  it("applies the current registry and follows later changes until unsubscribed", () => {
    registerStylesheet(EXT, { id: "a", css: A });
    const stop = initStylesheets();
    expect(ids()).toEqual(["a"]);
    registerStylesheet(OTHER, { id: "b", css: B });
    expect(ids()).toEqual(["a", "b"]);
    unregisterExtension(EXT);
    expect(ids()).toEqual(["b"]);
    stop();
    registerStylesheet(EXT, { id: "c", css: C });
    expect(ids()).toEqual(["b"]);
  });
});

describe("adoptedStyleSheets path", () => {
  class FakeSheet {
    css = "";
    replaceSync(css: string): void {
      if (css.includes("@import")) throw new Error("@import is not allowed");
      this.css = css;
    }
  }
  interface StubDoc {
    adoptedStyleSheets: FakeSheet[];
    defaultView: { CSSStyleSheet: typeof FakeSheet };
    head: HTMLHeadElement;
  }
  const stubDocument = (): StubDoc => ({
    adoptedStyleSheets: [],
    defaultView: { CSSStyleSheet: FakeSheet },
    head: document.createElement("head"),
  });
  const sync = (doc: StubDoc) => syncStylesheets(sheets(), doc as unknown as Document);
  const css = (doc: StubDoc) => doc.adoptedStyleSheets.map((s) => s.css);

  it("adopts one constructed sheet per contribution, after sheets the document already adopted", () => {
    const doc = stubDocument();
    const foreign = new FakeSheet();
    doc.adoptedStyleSheets = [foreign];
    registerStylesheet(EXT, { id: "a", css: A });
    registerStylesheet(OTHER, { id: "b", css: B });
    sync(doc);
    expect(doc.adoptedStyleSheets[0]).toBe(foreign);
    expect(css(doc)).toEqual(["", A, B]);
  });

  it("reuses the sheet object when the CSS changes and drops it on unregister", () => {
    const doc = stubDocument();
    registerStylesheet(EXT, { id: "a", css: A });
    sync(doc);
    const sheet = doc.adoptedStyleSheets[0];
    registerStylesheet(EXT, { id: "a", css: B });
    sync(doc);
    expect(doc.adoptedStyleSheets[0]).toBe(sheet);
    expect(sheet.css).toBe(B);
    unregisterStylesheet(EXT, "a");
    sync(doc);
    expect(doc.adoptedStyleSheets).toEqual([]);
  });

  it("refuses CSS the sheet rejects (@import) without throwing, leaving it empty", () => {
    const doc = stubDocument();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      registerStylesheet(EXT, { id: "a", css: '@import url("x.css");' });
      expect(() => sync(doc)).not.toThrow();
      expect(css(doc)).toEqual([""]);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});
