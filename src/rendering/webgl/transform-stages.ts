// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Stages that belong to a display transform (ProcessingStageContribution
// .transform) run only in frames drawn with it. A renderer that draws many
// photos switches transforms between them, so the set is cut per frame from
// the stages it holds rather than at registration.

import type { ProcessingStageContribution } from "@/extensions/types";

type StageSet = ProcessingStageContribution[] | Record<string, ProcessingStageContribution>;

/** `stages` without those that belong to a transform other than
 *  `transformId`; `stages` itself when none is left out, so memos keyed on the
 *  set keep their entries. */
export function stagesForTransform(stages: StageSet, transformId: string): StageSet {
  const list = Array.isArray(stages) ? stages : Object.values(stages);
  if (list.every((s) => s.transform === undefined || s.transform === transformId)) return stages;
  return list.filter((s) => s.transform === undefined || s.transform === transformId);
}
