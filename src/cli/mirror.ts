// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Reads the files Safelight mirrors into userData: shared settings and
// extension descriptors.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { GlslType } from "@/extensions/api/contributions";
import { registerStageParams } from "@/extensions/param-registry";
import {
  DESCRIPTORS_DIR,
  GUI_HEARTBEAT_FILE,
  SHARED_SETTINGS_FILE,
  descriptorFileName,
  type ExtensionDescriptors,
  type SharedSettings,
} from "@/state/shared-settings";

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** When the app last said it was open, or 0 when it never has. */
export function guiHeartbeatAt(userData: string): number {
  const doc = readJson(path.join(userData, GUI_HEARTBEAT_FILE));
  return isRecord(doc) && typeof doc.writtenAt === "number" ? doc.writtenAt : 0;
}

export function readSharedSettings(userData: string): SharedSettings | null {
  const doc = readJson(path.join(userData, SHARED_SETTINGS_FILE));
  if (!isRecord(doc) || doc.version !== 1 || !isRecord(doc.storage)) return null;
  const storage: Record<string, string> = {};
  for (const [key, value] of Object.entries(doc.storage)) {
    if (typeof value === "string") storage[key] = value;
  }
  return {
    version: 1,
    appVersion: typeof doc.appVersion === "string" ? doc.appVersion : "",
    writtenAt: Math.max(typeof doc.writtenAt === "number" ? doc.writtenAt : 0, guiHeartbeatAt(userData)),
    guiPid: typeof doc.guiPid === "number" ? doc.guiPid : null,
    recentProjects: Array.isArray(doc.recentProjects)
      ? doc.recentProjects.filter((p): p is string => typeof p === "string")
      : [],
    storage,
  };
}

export function readDescriptors(
  userData: string,
  installed: readonly { id: string; version: string }[],
): Map<string, ExtensionDescriptors> {
  const found = new Map<string, ExtensionDescriptors>();
  for (const { id, version } of installed) {
    const doc = readJson(path.join(userData, DESCRIPTORS_DIR, descriptorFileName(id, version)));
    if (!isRecord(doc) || doc.version !== 1 || doc.id !== id) continue;
    if (!Array.isArray(doc.stages) || !Array.isArray(doc.uniforms)) continue;
    found.set(id, doc as unknown as ExtensionDescriptors);
  }
  return found;
}

/** Registers the descriptors' uniforms in param-registry, so values normalize as in Safelight. */
export function seedParamRegistry(descriptors: Iterable<ExtensionDescriptors>): void {
  for (const d of descriptors) {
    const stageIds = d.stages.map((s) => s.id);
    const byStage = new Map<string, ExtensionDescriptors["uniforms"]>();
    for (const u of d.uniforms) {
      // A uniform's key is the bag key (`<stage>.<key>`); one with no stage prefix belongs to the first stage.
      const stage = stageIds.find((id) => u.key.startsWith(`${id}.`)) ?? stageIds[0];
      if (stage === undefined) continue;
      byStage.set(stage, [...(byStage.get(stage) ?? []), u]);
    }
    for (const [stage, uniforms] of byStage) {
      registerStageParams(
        stage,
        d.name,
        d.id,
        uniforms.map((u) => ({
          key: u.key.startsWith(`${stage}.`) ? u.key.slice(stage.length + 1) : u.key,
          glslType: u.glslType as GlslType,
          default: u.default as number | number[] | boolean,
          range: u.range,
          label: u.label,
        })),
      );
    }
  }
}
