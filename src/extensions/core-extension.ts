// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A leaf module: the registry, the stage check, the loaders and the built-in
// extension list each need to name the core extension, and none of them can
// import another without a cycle.

/** The built-in extension that owns Safelight's own contributions: the stock
 *  themes, the Classic layout, the built-in transform and the core processing
 *  stages (vignette, grain, the built-in denoiser). Registration refuses the
 *  ids of those stages (builtin-stage.ts) from any other extension, other
 *  built-ins (core.hsl, core.devtools) included. */
export const CORE_EXTENSION_ID = "core";

/** An id only Safelight's own extensions may hold: "core" and everything under
 *  "core.", compared without case because the plugins folder may sit on a
 *  filesystem that ignores it. An installed or dev-folder extension sharing one
 *  would share the registry id of a built-in, so stopping it would sweep
 *  Safelight's own contributions. electron/extension-origins.cjs states the
 *  same rule for the main process. */
export function isReservedExtensionId(id: string): boolean {
  const lower = id.toLowerCase();
  return lower === CORE_EXTENSION_ID || lower.startsWith(`${CORE_EXTENSION_ID}.`);
}

/** Why a reserved id is refused, as the error and the log line say it. */
export const reservedIdReason = (id: string): string =>
  `${id}: extension ids under '${CORE_EXTENSION_ID}' are reserved for Safelight`;
