import type { UniformDeclaration, GlslType } from "./types";

export interface ParamDescriptor {
  qualifiedKey: string;
  localKey: string;
  stageId: string;
  extensionId: string;
  glslType: GlslType;
  default: number | number[] | boolean;
  range?: { min: number; max: number; step?: number };
  label?: string;
}

const descriptors = new Map<string, ParamDescriptor>();

export function registerStageParams(
  stageId: string,
  extensionId: string,
  uniforms: UniformDeclaration[],
): void {
  for (const u of uniforms) {
    const qk = `${stageId}.${u.key}`;
    descriptors.set(qk, {
      qualifiedKey: qk,
      localKey: u.key,
      stageId,
      extensionId,
      glslType: u.glslType,
      default: u.default,
      range: u.range,
      label: u.label,
    });
  }
}

export function unregisterStageParams(stageId: string): void {
  for (const [key, d] of descriptors) {
    if (d.stageId === stageId) descriptors.delete(key);
  }
}

export function unregisterExtensionParams(extensionId: string): void {
  for (const [key, d] of descriptors) {
    if (d.extensionId === extensionId) descriptors.delete(key);
  }
}

export function getParamDescriptor(qualifiedKey: string): ParamDescriptor | undefined {
  return descriptors.get(qualifiedKey);
}

export function getAllDescriptors(): ReadonlyMap<string, ParamDescriptor> {
  return descriptors;
}

export function getDefaults(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, d] of descriptors) {
    out[key] = d.default;
  }
  return out;
}

function valueMatchesType(value: unknown, type: GlslType): boolean {
  switch (type) {
    case "float":
    case "int":
      return typeof value === "number";
    case "bool":
      return typeof value === "boolean";
    default: // vecN / ivecN / matN / sampler — represented as a number array
      return Array.isArray(value);
  }
}

/** Sanitise a persisted/preset param bag before it drives the GPU. For keys with
 *  a registered descriptor we keep only type-valid values (a wrong type falls
 *  back to the uniform's default at bind time, so it's simply omitted here).
 *  Keys with NO descriptor are preserved untouched: an extension may be
 *  temporarily disabled, and silently discarding its saved params would destroy
 *  the user's edits the next time the photo is committed. */
export function normalizeParamBag(
  bag: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!bag || typeof bag !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bag)) {
    const d = descriptors.get(key);
    if (!d) {
      out[key] = value; // unknown (extension absent) — preserve
      continue;
    }
    if (valueMatchesType(value, d.glslType)) out[key] = value;
  }
  return out;
}
