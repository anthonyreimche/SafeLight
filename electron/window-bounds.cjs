// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Window sizing against the display it sits on. The nominal minimum applies
// only while the work area can hold it: a frame larger than the screen pushes
// the titleBarOverlay buttons out of reach. Pure so the unit suite pins it.

"use strict";

/** The nominal minimum, capped to the work area on each axis. */
function effectiveMinimum(min, workArea) {
  return {
    width: Math.min(min.width, workArea.width),
    height: Math.min(min.height, workArea.height),
  };
}

/** A size held between the effective minimum and the work area. */
function fitToWorkArea(size, min, workArea) {
  const lo = effectiveMinimum(min, workArea);
  const clamp = (v, low, high) => Math.max(low, Math.min(high, v));
  return {
    width: clamp(size.width, lo.width, workArea.width),
    height: clamp(size.height, lo.height, workArea.height),
  };
}

module.exports = { effectiveMinimum, fitToWorkArea };
