// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Every panel left core (#178), so the only built-in it ships is the locked core
// extension. Tests of how a built-in is switched on and off, listed and kept out
// of presets install this stand-in one, as the built-in panels were.

import type { BuiltinExtension } from "./builtin";
import { BUILTIN_EXTENSIONS } from "./builtin";
import { noteBuiltinExtensions } from "./core-extension";

export const PROBE_BUILTIN_ID = "core.probe";

/** Adds a built-in that registers a panel to BUILTIN_EXTENSIONS; returns the
 *  function that takes it out again. Its id stays a built-in's. */
export function installProbeBuiltin(): { builtin: BuiltinExtension; remove: () => void } {
  const builtin: BuiltinExtension = {
    id: PROBE_BUILTIN_ID,
    name: "Probe",
    version: "1.0.0",
    activate: (api) =>
      api.registerPanel({ id: PROBE_BUILTIN_ID, title: "Probe", component: () => null }),
  };
  BUILTIN_EXTENSIONS.push(builtin);
  noteBuiltinExtensions([PROBE_BUILTIN_ID]);
  return {
    builtin,
    remove: () => {
      const at = BUILTIN_EXTENSIONS.indexOf(builtin);
      if (at >= 0) BUILTIN_EXTENSIONS.splice(at, 1);
    },
  };
}
