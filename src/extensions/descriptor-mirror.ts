// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What an installed extension registered, written to userData once it has
// started, so `slu` can list its tools and check its values without running it.
// One file per id@version: the app and the engine never write the same one at
// once, and a file is only ever rewritten with the same content.

import { useRegistry } from "./registry";
import { getAllDescriptors, isComputedParam } from "./param-registry";
import { declaredUniforms } from "./stage-validation";
import { privilegedMirror } from "@/native/privileged";
import type { ExtensionDescriptors } from "@/state/shared-settings";

const written = new Set<string>();

function describe(id: string, version: string, name: string): ExtensionDescriptors {
  const registry = useRegistry.getState();
  const stages = Object.values(registry.processingStages).filter((s) => s.extensionId === id);
  const stageIds = new Set(stages.map((s) => s.id));
  // Display transforms' params are left out: the descriptor format names their
  // owner by stage, and a transform is not one.
  const uniforms = [...getAllDescriptors().values()].filter(
    (d) => d.extensionId === id && stageIds.has(d.stageId),
  );
  return {
    version: 1,
    id,
    extVersion: version,
    name,
    writtenAt: Date.now(),
    stages: stages.map(({ id: stageId, phase, priority, after, anchor }) => ({
      id: stageId,
      phase,
      priority,
      after,
      anchor,
    })),
    uniforms: uniforms.map((d) => ({
      key: d.qualifiedKey,
      glslType: d.glslType,
      ...(d.length !== undefined && { length: d.length }),
      default: d.default,
      range: d.range,
      label: d.label,
    })),
    panels: Object.values(registry.panels)
      .filter((p) => p.extensionId === id)
      .map((p) => ({ id: p.id, title: p.title, owns: p.owns && [...p.owns] })),
    hasCatalogHooks: Object.values(registry.catalogHooks).some((h) => h.extensionId === id),
    computed: [
      ...new Set(
        stages.flatMap((s) => declaredUniforms(s).map((u) => `${s.id}.${u.key}`)).filter(isComputedParam),
      ),
    ],
  };
}

/** Write `id`@`version`'s registrations for `slu`, the first time it starts in
 *  this session. A failed write is logged and never reaches the caller. */
export function mirrorExtensionDescriptors(id: string, version: string, name: string): void {
  const key = `${id}@${version}`;
  if (written.has(key)) return;
  const bridge = privilegedMirror();
  if (!bridge?.writeDescriptors) return;
  written.add(key);
  const failed = (e: unknown) => console.warn(`[extensions] could not record ${key} for slu:`, e);
  try {
    bridge.writeDescriptors(describe(id, version, name)).catch(failed);
  } catch (e) {
    failed(e);
  }
}
