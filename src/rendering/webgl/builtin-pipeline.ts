// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { ResolvedPipeline } from "@/rendering/webgl/resolved-pipeline";

/** The stock Safelight transform baked into the fragment shader, with a stable
 *  identity (sig "" = the stock program). A renderer draws with it until handed
 *  a pipeline and falls back to it when a contributed transform fails to
 *  compile; pipelines resolve to it when nothing else is registered. */
export const BUILTIN_RESOLVED: ResolvedPipeline = {
  id: "core.pipeline",
  glsl: null,
  skipBaseCurve: false,
  skipToneShoulder: false,
  sig: "",
};
