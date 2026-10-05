// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A leaf module: the registry, the stage check and the built-in extension list
// each need to name the core extension, and none of them can import another
// without a cycle.

/** The built-in extension that owns Safelight's own contributions: the stock
 *  themes, the Classic layout, the built-in transform and the core processing
 *  stages (vignette, grain, the built-in denoiser). Registration refuses the
 *  ids of those stages (builtin-stage.ts) from any other extension, other
 *  built-ins (core.hsl, core.devtools) included. */
export const CORE_EXTENSION_ID = "core";
