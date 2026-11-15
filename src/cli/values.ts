// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The values `safelight` can list, read and set: core controls plus extension
// uniforms from the descriptor mirror.

import { DEFAULT_DEVELOP_PARAMS } from "@/catalog/defaults";
import type { DevelopParams } from "@/catalog/develop-params";
import {
  DEVELOP_CONTROLS,
  READ_ONLY_PARAMS,
  controlDefault,
  readControl,
  writeControl,
  type DevelopControl,
} from "@/catalog/develop-controls";
import { ESSENTIAL_ADJUSTMENTS } from "@/extensions/essential-params";
import { PROCESSING_PHASE_ORDER } from "@/extensions/api/contributions";
import type { ExtensionDescriptors } from "@/state/shared-settings";
import { closest } from "./suggest";
import {
  CliError,
  type ApplyResult,
  type Assignment,
  type InstalledExtension,
  type Look,
  type ToolRef,
  type ValueChange,
  type ValueInfo,
  type ValueService, COMMAND } from "./types";

const CORE_ID = "core";
const CORE_PREFIX = "safelight.";

const norm = (text: string): string => text.trim().toLowerCase().replaceAll("colour", "color");
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const tidy = (n: number): number => Math.round(n * 1e6) / 1e6;
const shortId = (id: string): string => (id.startsWith(CORE_PREFIX) ? id.slice(CORE_PREFIX.length) : id);

/** Names that pick a tool: its id, its id without "safelight.", and its name with spaces as hyphens. */
function toolNames(tool: ToolRef): string[] {
  const dashed = tool.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return [tool.id, shortId(tool.id), dashed, tool.name].map(norm);
}

const decimalsOf = (step: number | undefined, fallback: number): number => {
  if (step === undefined) return fallback;
  const text = String(step);
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
};

/** What the GUI calls the step a slider drag makes. */
function stepLabel(info: ValueInfo, control: DevelopControl | undefined): string {
  if (!control) return info.label;
  const [first, second] = control.key.split(".");
  switch (control.toolId) {
    case "safelight.white-balance":
      return control.key === "temperature" ? "Temperature" : "Tint";
    case "safelight.effects":
      return `${control.group} ${control.label}`;
    case "safelight.detail":
      return control.group === "Sharpening" ? `Sharpening ${control.label}` : control.label;
    case "safelight.color-grading":
      return `Colour Grading – ${control.group}`;
    case "safelight.hsl":
      return `HSL ${control.key.split(".")[2]}`;
    case "safelight.transform":
      return first === "uprightMode" ? "Upright" : second === undefined ? control.label : "Transform";
    default:
      return control.label;
  }
}

interface ExtensionValue { info: ValueInfo; fallback: unknown }

export function createValueService(
  descriptors: ReadonlyMap<string, ExtensionDescriptors>,
  installed: readonly Pick<InstalledExtension, "id" | "name" | "enabled">[],
  disabled: readonly string[],
): ValueService {
  const coreIds = new Set(ESSENTIAL_ADJUSTMENTS.map((e) => e.id));
  const controlsByTool = new Map<string, DevelopControl[]>();
  for (const c of DEVELOP_CONTROLS) controlsByTool.set(c.toolId, [...(controlsByTool.get(c.toolId) ?? []), c]);

  const tools: ToolRef[] = ESSENTIAL_ADJUSTMENTS.map((e, order) => ({
    id: e.id,
    name: e.name,
    kind: "core",
    installed: true,
    enabled: !disabled.includes(e.id),
    settable: controlsByTool.has(e.id),
    order,
    hasCommitHooks: false,
  }));
  tools.push({
    id: CORE_ID, name: "Display", kind: "core", installed: true, enabled: true, settable: true,
    order: tools.length, hasCommitHooks: false,
  });

  const phaseRank = new Map<string, number>(PROCESSING_PHASE_ORDER.map((p, i) => [p, i]));
  const firstStage = (d: ExtensionDescriptors | undefined): [number, number] => {
    const ranks = (d?.stages ?? []).map((s): [number, number] => [phaseRank.get(s.phase) ?? 99, s.priority ?? 0]);
    return ranks.sort((a, b) => a[0] - b[0] || a[1] - b[1])[0] ?? [Infinity, 0];
  };
  const extensionIds = [...new Set([...installed.map((i) => i.id), ...descriptors.keys()])].filter((id) => !coreIds.has(id));
  const extensionTools = extensionIds
    .map((id) => {
      const record = installed.find((i) => i.id === id);
      const descriptor = descriptors.get(id);
      return { id, name: record?.name ?? descriptor?.name ?? id, record, descriptor, rank: firstStage(descriptor) };
    })
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.name.localeCompare(b.name));
  for (const e of extensionTools) {
    tools.push({
      id: e.id,
      name: e.name,
      kind: "extension",
      installed: true,
      enabled: (e.record?.enabled ?? true) && !disabled.includes(e.id),
      settable: false,
      order: tools.length,
      hasCommitHooks: e.descriptor?.hasCatalogHooks ?? false,
    });
  }
  const toolById = new Map(tools.map((t) => [t.id, t]));
  const toolOf = (id: string): ToolRef => toolById.get(id) ?? (toolById.get(CORE_ID) as ToolRef);

  const infos: ValueInfo[] = [];
  const controlOf = new Map<ValueInfo, DevelopControl>();
  for (const c of DEVELOP_CONTROLS) {
    const info: ValueInfo = {
      key: c.key, label: c.label, tool: toolOf(c.toolId), kind: c.kind, settable: true,
      ...(c.min !== undefined && { min: c.min }),
      ...(c.max !== undefined && { max: c.max }),
      ...(c.step !== undefined && { step: c.step }),
      ...(c.unit && { unit: c.unit }),
      ...(c.decimals !== undefined && { decimals: c.decimals }),
      ...(c.choices && { choices: c.choices }),
    };
    infos.push(info);
    controlOf.set(info, c);
  }

  const extensionValues = new Map<string, ExtensionValue>();
  for (const e of extensionTools) {
    const tool = toolOf(e.id);
    const reason = `${tool.name} doesn't support ${COMMAND} yet. Set it in Safelight.`;
    for (const u of e.descriptor?.uniforms ?? []) {
      if (u.glslType !== "float" && u.glslType !== "int" && u.glslType !== "bool") continue;
      const stage = e.descriptor?.stages.find((s) => u.key.startsWith(`${s.id}.`));
      const local = stage ? u.key.slice(stage.id.length + 1) : u.key;
      const info: ValueInfo = {
        key: u.key,
        label: u.label ?? local,
        tool,
        kind: u.glslType === "bool" ? "switch" : "number",
        settable: false,
        notSettableReason: reason,
        ...(u.range && { min: u.range.min, max: u.range.max }),
        ...(u.range?.step !== undefined && { step: u.range.step }),
        ...(u.glslType !== "bool" && { decimals: decimalsOf(u.range?.step, u.glslType === "int" ? 0 : 2) }),
      };
      infos.push(info);
      extensionValues.set(u.key, { info, fallback: u.default });
    }
  }

  const readOnlyInfo = (key: string): ValueInfo => {
    const top = key.split(".")[0];
    const owner = ESSENTIAL_ADJUSTMENTS.find((e) => (e.params as readonly string[]).includes(top));
    return {
      key, label: key, tool: toolOf(owner?.id ?? CORE_ID), kind: "id", settable: false,
      notSettableReason: READ_ONLY_PARAMS[top],
    };
  };

  const byKey = new Map<string, ValueInfo>();
  for (const info of infos) if (!byKey.has(norm(info.key))) byKey.set(norm(info.key), info);

  function shorthand(input: string): ValueInfo | undefined {
    const hits = new Set<ValueInfo>();
    for (const tool of tools) {
      if (tool.kind !== "extension") continue;
      for (const prefix of new Set([norm(tool.id), norm(shortId(tool.id))])) {
        if (!input.startsWith(`${prefix}.`)) continue;
        const rest = input.slice(prefix.length + 1);
        for (const info of infos) {
          if (info.tool !== tool) continue;
          const key = norm(info.key);
          if (key === rest || key.endsWith(`.${rest}`)) hits.add(info);
        }
      }
    }
    return hits.size === 1 ? [...hits][0] : undefined;
  }

  const readOf = (look: Look, info: ValueInfo): unknown => {
    const control = controlOf.get(info);
    if (control) return readControl(look.params, control);
    const ext = extensionValues.get(info.key);
    if (ext) return info.key in look.paramBag ? look.paramBag[info.key] : ext.fallback;
    return (look.params as unknown as Record<string, unknown>)[info.key.split(".")[0]];
  };

  const defaultOf = (info: ValueInfo, asShot: number): unknown => {
    const control = controlOf.get(info);
    return control ? controlDefault(control, asShot) : extensionValues.get(info.key)?.fallback;
  };

  function parseNumber(assign: Assignment, info: ValueInfo): number {
    const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(.*)$/i.exec(assign.value.trim());
    if (!match) throw new CliError(1, `"${assign.value}" is not a number for ${info.label}.`);
    const unit = match[2];
    if (unit !== "") {
      const own = info.unit;
      const ok = own !== undefined && (norm(unit) === norm(own) || (own === "°" && norm(unit) === "deg"));
      if (!ok) {
        throw new CliError(
          1,
          own ? `${info.label} is in ${own}, not "${unit}".` : `${info.label} has no unit; "${assign.value}" can't take "${unit}".`,
        );
      }
    }
    const n = Number(match[1]);
    if (!Number.isFinite(n)) throw new CliError(1, `"${assign.value}" is not a number for ${info.label}.`);
    return n;
  }

  function nextValue(
    look: Look,
    assign: Assignment,
    info: ValueInfo,
    opts: { asShot: number; strict: boolean },
  ): { value: unknown; clamped?: ValueChange["clamped"] } {
    const isDefault = assign.value.trim().toLowerCase() === "default";
    if (isDefault) {
      if (assign.op !== "=") throw new CliError(1, `"default" works with "=", not "${assign.op}".`);
      return { value: defaultOf(info, opts.asShot) };
    }
    switch (info.kind) {
      case "switch": {
        if (assign.op !== "=") throw new CliError(1, `${info.label} is a switch; use "=".`);
        const word = assign.value.trim().toLowerCase();
        if (["on", "true", "1"].includes(word)) return { value: true };
        if (["off", "false", "0"].includes(word)) return { value: false };
        throw new CliError(1, `${info.label} takes on or off, not "${assign.value}".`);
      }
      case "choice": {
        if (assign.op !== "=") throw new CliError(1, `${info.label} takes a name; use "=".`);
        const word = assign.value.trim().toLowerCase();
        const choice = info.choices?.find((c) => c.value.toLowerCase() === word || c.label.toLowerCase() === word);
        if (!choice) {
          const names = (info.choices ?? []).map((c) => c.value).join(", ");
          throw new CliError(1, `${info.label} takes one of: ${names}. Not "${assign.value}".`);
        }
        return { value: choice.value };
      }
      case "id": {
        if (assign.op !== "=") throw new CliError(1, `${info.label} takes a name; use "=".`);
        const id = assign.value.trim();
        if (id === "") throw new CliError(1, `${info.label} needs a name, or "default".`);
        return { value: id };
      }
      case "number": {
        const entered = parseNumber(assign, info);
        const current = Number(readOf(look, info));
        const typed = assign.op === "=" ? entered : assign.op === "+=" ? current + entered : current - entered;
        const wanted = info.decimals === 0 ? Math.round(typed) || 0 : typed;
        const low = info.min ?? -Infinity;
        const high = info.max ?? Infinity;
        const limit = Math.min(Math.max(wanted, low), high);
        if (limit === wanted) return { value: tidy(wanted) };
        if (opts.strict) {
          throw new CliError(1, `${info.label} can't be ${tidy(wanted)}; its range is ${low} to ${high}.`);
        }
        return { value: limit, clamped: { requested: tidy(wanted), limit } };
      }
    }
    throw new CliError(1, `${info.label} can't be set by ${COMMAND} yet.`);
  }

  function apply(look: Look, assigns: Assignment[], opts: { asShot: number; strict: boolean }): ApplyResult {
    let params: DevelopParams = look.params;
    const changes: ValueChange[] = [];
    for (const assign of assigns) {
      const info = service.resolveKey(assign.key);
      if (!info.settable) {
        throw new CliError(1, info.notSettableReason ?? `${info.label} can't be set by ${COMMAND} yet.`);
      }
      const { value, clamped } = nextValue({ params, paramBag: look.paramBag }, assign, info, opts);
      const control = controlOf.get(info) as DevelopControl;
      const before = readControl(params, control);
      params = writeControl(params, control, value);
      changes.push({ info, before, after: value, ...(clamped && { clamped }) });
    }
    const moved = changes.filter((c) => !same(c.before, c.after));
    const labels = (moved.length > 0 ? moved : changes).map((c) => stepLabel(c.info, controlOf.get(c.info)));
    return { look: { params, paramBag: look.paramBag }, changes, label: [...new Set(labels)].join(", ") };
  }

  const clone = <T>(value: T): T => structuredClone(value);

  const ownsBagKey = (tool: ToolRef, key: string): boolean => {
    const descriptor = descriptors.get(tool.id);
    if (descriptor?.uniforms.some((u) => u.key === key)) return true;
    const prefixes = [
      ...(descriptor?.stages.map((s) => s.id) ?? []),
      tool.id,
      shortId(tool.id),
    ];
    return prefixes.some((prefix) => key.startsWith(`${prefix}.`));
  };

  const withoutBagKeys = (bag: Record<string, unknown>, drop: (key: string) => boolean): Record<string, unknown> =>
    Object.fromEntries(Object.entries(bag).filter(([key]) => !drop(key)));

  const resetParamKeys = (params: DevelopParams, keys: readonly (keyof DevelopParams)[], asShot: number): DevelopParams => {
    const next = { ...params } as Record<string, unknown>;
    for (const key of keys) next[key] = key === "temperature" ? asShot : clone(DEFAULT_DEVELOP_PARAMS[key]);
    return next as unknown as DevelopParams;
  };

  const service: ValueService = {
    tools: () => tools.slice(),

    tool(name) {
      const wanted = norm(name).replace(/[^a-z0-9.]+/g, "-");
      const found = tools.find((t) => toolNames(t).some((n) => n === norm(name) || n.replace(/[^a-z0-9.]+/g, "-") === wanted));
      if (found) return found;
      const near = closest(wanted, tools.flatMap((t) => toolNames(t).map((n) => n.replace(/[^a-z0-9.]+/g, "-"))));
      throw new CliError(1, `No tool called "${name}".`, near ? `Did you mean "${near}"? ${COMMAND} tools lists them.` : `${COMMAND} tools lists them.`);
    },

    values: (toolId) => infos.filter((i) => toolId === undefined || i.tool.id === toolId),

    resolveKey(input) {
      const key = norm(input);
      const found = byKey.get(key) ?? shorthand(key);
      if (found) return found;
      const top = input.trim().split(".")[0];
      if (Object.hasOwn(READ_ONLY_PARAMS, top)) return readOnlyInfo(input.trim());
      const near = closest(key, [...byKey.keys()]);
      const nearName = near ? byKey.get(near)?.key : undefined;
      throw new CliError(1, `No value called "${input}".`, nearName ? `Did you mean "${nearName}"? ${COMMAND} tools lists them.` : `${COMMAND} tools lists them.`);
    },

    read: readOf,

    isDefault(look, info, asShot) {
      const control = controlOf.get(info);
      if (!control) {
        const ext = extensionValues.get(info.key);
        return ext === undefined || !(info.key in look.paramBag) || same(look.paramBag[info.key], ext.fallback);
      }
      return same(readControl(look.params, control), defaultOf(info, asShot));
    },

    apply,

    resetTool(look, toolId, asShot) {
      const tool = service.tool(toolId);
      if (tool.id === CORE_ID) return { ...look, params: { ...look.params, displayTransform: null } };
      if (tool.kind === "core") {
        const params = ESSENTIAL_ADJUSTMENTS.find((e) => e.id === tool.id)?.params ?? [];
        return { ...look, params: resetParamKeys(look.params, params, asShot) };
      }
      return { ...look, paramBag: withoutBagKeys(look.paramBag, (key) => ownsBagKey(tool, key)) };
    },

    resetKeys(look, keys, asShot) {
      if (keys === "all") {
        const params = ESSENTIAL_ADJUSTMENTS.flatMap((e) => e.params).filter((k) => !Object.hasOwn(READ_ONLY_PARAMS, k));
        const reset = resetParamKeys(look.params, params, asShot);
        const extension = tools.filter((t) => t.kind === "extension");
        return {
          params: { ...reset, displayTransform: null },
          paramBag: withoutBagKeys(look.paramBag, (key) => extension.some((t) => ownsBagKey(t, key))),
        };
      }
      let { params, paramBag } = look;
      for (const input of keys) {
        const info = service.resolveKey(input);
        const control = controlOf.get(info);
        if (control) params = writeControl(params, control, controlDefault(control, asShot));
        else if (extensionValues.has(info.key)) paramBag = withoutBagKeys(paramBag, (k) => k === info.key);
        else throw new CliError(1, info.notSettableReason ?? `${info.label} can't be reset by ${COMMAND} yet.`);
      }
      return { params, paramBag };
    },
  };
  return service;
}
