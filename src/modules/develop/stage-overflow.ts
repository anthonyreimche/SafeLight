// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { getExtensionName } from "@/extensions/param-registry";
import type { RegisteredProcessingStage } from "@/extensions/registry";

/** What Develop says about the stages a frame was drawn without: each owning
 *  extension named once, in the order its stages run. null when it ran them all. */
export function overflowNotice(
  stageIds: readonly string[],
  stages: Readonly<Record<string, RegisteredProcessingStage>>,
): string | null {
  if (stageIds.length === 0) return null;
  const names = [
    ...new Set(stageIds.map((id) => (stages[id] ? getExtensionName(stages[id].extensionId) : id))),
  ];
  const listed =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
  return `Can't apply ${listed}. Too many effects are on for this graphics card.`;
}
