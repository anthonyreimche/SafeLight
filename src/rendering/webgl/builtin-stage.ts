// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { ProcessingStageContribution } from "@/extensions/types";
import { BUILTIN_DENOISE_ID } from "./builtin-denoise";

// Which processing stages are Safelight's own. The id set is decided here and
// nowhere else: the renderer builds its stock program from it, the injection
// gives core stages their raw uniforms, and registration keeps the ids for the
// core extension.
//
// The two predicates differ by one id, on purpose. A core stage (an id under
// "core.": Vignette, Grain) keeps raw uniform names that render() binds by hand
// from typed DevelopParams. The built-in denoiser is namespaced like an
// extension's stage: its uniforms are prefixed and its params ride the param bag
// (denoiseBag). The injection therefore asks isCoreStage; the stock program,
// which wants every stage Safelight ships, and the reserved ids ask
// isBuiltInStage.
//
// A leaf module: stage-injection.ts, renderer.ts and the extensions' stage check
// all import it, so it imports no more than the denoiser's id. The extension
// that owns these stages is named in extensions/core-extension.ts.

const CORE_STAGE_PREFIX = "core.";

type StageRef = Pick<ProcessingStageContribution, "id">;

/** Safelight's own stage: an id under "core." or the built-in denoiser. Anything
 *  else came from an extension. */
export const isBuiltInStage = (s: StageRef): boolean =>
  s.id.startsWith(CORE_STAGE_PREFIX) || s.id === BUILTIN_DENOISE_ID;

/** A built-in stage that gets the injection's core treatment: raw uniform names
 *  and no param-bag bindings. Every built-in stage but the denoiser. */
export const isCoreStage = (s: StageRef): boolean =>
  isBuiltInStage(s) && s.id !== BUILTIN_DENOISE_ID;
