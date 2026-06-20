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
