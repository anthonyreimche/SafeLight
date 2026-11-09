// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installNativeDragGuard } from "./native-drag-guard";

let uninstall: () => void;

beforeEach(() => {
  uninstall = installNativeDragGuard(document);
});

afterEach(() => {
  uninstall();
  document.body.innerHTML = "";
});

function dragFrom(target: Node): boolean {
  const e = new Event("dragstart", { bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e.defaultPrevented;
}

describe("installNativeDragGuard", () => {
  it("stops a native drag of the canvas, which would cancel a crop or pan drag", () => {
    document.body.innerHTML = `<div><canvas></canvas></div>`;
    expect(dragFrom(document.querySelector("canvas")!)).toBe(true);
  });

  it("stops a drag of selected text", () => {
    document.body.innerHTML = `<p>Exposure</p>`;
    expect(dragFrom(document.querySelector("p")!.firstChild!)).toBe(true);
  });

  it("stops a drag of an image or a link", () => {
    document.body.innerHTML = `<img alt="" /><a href="https://example.com">x</a>`;
    expect(dragFrom(document.querySelector("img")!)).toBe(true);
    expect(dragFrom(document.querySelector("a")!)).toBe(true);
  });

  it("leaves drags the app opted into", () => {
    document.body.innerHTML = `<div draggable="true"><img alt="" /></div>`;
    expect(dragFrom(document.querySelector("div")!)).toBe(false);
    expect(dragFrom(document.querySelector("img")!)).toBe(false);
  });

  it("leaves text drags inside editable fields", () => {
    document.body.innerHTML = `<input value="a" /><textarea>b</textarea><div contenteditable="true">c</div>`;
    expect(dragFrom(document.querySelector("input")!)).toBe(false);
    expect(dragFrom(document.querySelector("textarea")!)).toBe(false);
    expect(dragFrom(document.querySelector("[contenteditable]")!.firstChild!)).toBe(false);
  });

  it("stops guarding once uninstalled", () => {
    uninstall();
    document.body.innerHTML = `<canvas></canvas>`;
    expect(dragFrom(document.querySelector("canvas")!)).toBe(false);
    uninstall = installNativeDragGuard(document);
  });
});
