// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { DevelopParams } from "@/catalog/types";
import type { ProcessingStageContribution } from "@/extensions/types";
import { getAllExtSettings } from "@/extensions/ext-settings";
import { stoppedEssentials, withStoppedEssentials } from "@/extensions/essential-params";
import { useRunningPlugins } from "@/extensions/running-plugins";
import { deriveStageValues, type DeriveContext } from "./stage-derive";

// What the stages derive in the window (stage-derive.ts), from what only the
// window holds: the extensions' stored settings and the essentials running in
// it. The render worker is handed the result.

type Stage = ProcessingStageContribution & { extensionId?: string };

/** The extensions' stored settings. getAllExtSettings is looked up per call,
 *  not bound when this module loads, so a mock of ext-settings that leaves it
 *  out (export-image.test.ts) fails only a derive that runs. */
export const windowDeriveContext: DeriveContext = { settingsFor: (id) => getAllExtSettings(id) };

/** The params the registered `stages` derive a frame of `params` from: a stopped
 *  essential's at their defaults, so a stage reading another tool's params drops
 *  that tool with it, as Develop draws it (essential-params.ts). */
export function paramsForDerive(params: DevelopParams, stages: readonly Stage[]): DevelopParams {
  return withStoppedEssentials(params, stoppedEssentials(useRunningPlugins.getState().ids, stages));
}

/** Every value `stages` derive from a frame of `params`, as Develop draws it. */
export function windowDerived(params: DevelopParams, stages: readonly Stage[]): Record<string, unknown> {
  return deriveStageValues(paramsForDerive(params, stages), stages, windowDeriveContext);
}
