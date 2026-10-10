// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The app's Reduce motion setting (Preferences, or the OS preference folded in)
// is the `sl-reduce-motion` class on <html>. CSS animations obey it through a
// stylesheet rule; animation driven from script (Element.animate, a per-frame
// lerp) must ask here, at the moment it would animate, so a change takes
// effect without remounting.
export function reducedMotion(): boolean {
  return document.documentElement.classList.contains("sl-reduce-motion");
}
