// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Setup for the `dom` vitest project (see vite.config.ts). jsdom ships no
// layout engine and no pointer-capture implementation, so a few DOM methods the
// UI calls unconditionally are simply missing from Element.prototype. They are
// stubbed here — not emulated — because the components under test only need
// them not to throw; anything that depends on the geometry they would produce
// is stubbed per-test instead, where the expected numbers are visible.

import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// `globals` is off, so Testing Library can't install its own auto-cleanup.
afterEach(cleanup);

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}

// user-event probes hasPointerCapture before every pointer gesture, so the
// three have to agree with each other rather than each being a no-op.
if (!Element.prototype.setPointerCapture) {
  const captured = new WeakMap<Element, Set<number>>();
  Element.prototype.setPointerCapture = function setPointerCapture(
    pointerId: number,
  ): void {
    const ids = captured.get(this) ?? new Set<number>();
    ids.add(pointerId);
    captured.set(this, ids);
  };
  Element.prototype.releasePointerCapture = function releasePointerCapture(
    pointerId: number,
  ): void {
    captured.get(this)?.delete(pointerId);
  };
  Element.prototype.hasPointerCapture = function hasPointerCapture(
    pointerId: number,
  ): boolean {
    return captured.get(this)?.has(pointerId) ?? false;
  };
}
