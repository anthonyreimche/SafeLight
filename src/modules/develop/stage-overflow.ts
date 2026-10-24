// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { getExtensionName } from "@/extensions/param-registry";
import type { RegisteredProcessingStage } from "@/extensions/registry";
import { stageOfCopy } from "@/rendering/webgl/mask-stage-instances";

/** What Develop says about the stages a frame was drawn without: each owning
 *  extension named once, in the order its stages run, a mask copy under its
 *  stage's. null when it ran them all. */
export function overflowNotice(
  stageIds: readonly string[],
  stages: Readonly<Record<string, RegisteredProcessingStage>>,
): string | null {
  if (stageIds.length === 0) return null;
  const nameOf = (id: string): string => {
    const stage = stages[stageOfCopy(id)];
    return stage ? getExtensionName(stage.extensionId) : id;
  };
  const names = [...new Set(stageIds.map(nameOf))];
  const listed =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
  return `Can't apply ${listed}. Too many effects are on for this graphics card.`;
}
