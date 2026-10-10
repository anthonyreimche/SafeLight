// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { afterEach, describe, expect, it } from "vitest";
import { reducedMotion } from "./reduced-motion";

afterEach(() => {
  document.documentElement.classList.remove("sl-reduce-motion");
});

describe("reducedMotion", () => {
  it("is false until the app's Reduce motion class is on <html>", () => {
    expect(reducedMotion()).toBe(false);
  });

  it("is true while <html> carries sl-reduce-motion", () => {
    document.documentElement.classList.add("sl-reduce-motion");
    expect(reducedMotion()).toBe(true);
  });

  it("follows the class when it is removed again", () => {
    const root = document.documentElement;
    root.classList.add("sl-reduce-motion");
    root.classList.remove("sl-reduce-motion");
    expect(reducedMotion()).toBe(false);
  });
});
