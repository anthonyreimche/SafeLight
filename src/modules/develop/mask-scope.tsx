// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Binds a mask sub-panel instance (PanelContribution.mask) to the mask it
// edits. The Masking panel wraps the selected mask's sub-panels in
// MaskScopeProvider; the components read and write ONLY through useMaskScope
// (or useParamScope, which is the same scope there), never the global develop
// params — so a panel contribution serves both the dock (global scope, its own
// component) and any number of masks (one mask.component instance each). Core
// values land in mask.adj / mask.hsl / mask.toneCurve, which the shader's
// local-adjustment path applies; extension params land in mask.bag, which runs
// a maskable stage's copy for the mask (mask-stage-instances.ts).

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { HSLAdjustments, MaskAdjustments, ToneCurves } from "@/catalog/types";
import { getParamDescriptor } from "@/extensions/param-registry";
import { useDevelopStore } from "@/state/develop-store";

/** Where a panel's extension params live: the photo's bag, or one mask's.
 *  Reads see the store as it is now, not as the render was handed it, so a
 *  drag's handler can start each step from the last one's write. */
export interface ParamScope {
  /** The mask being edited, or null for the photo's own values. */
  maskId: string | null;
  /** A param by qualified key ("{stageId}.{key}"). Reads fall back to the
   *  param's registered default when the scope stores nothing. */
  getParam(key: string): unknown;
  /** The values the scope stores, by qualified key, without defaults: the
   *  photo's paramBag or the mask's bag. */
  getParams(): Readonly<Record<string, unknown>>;
  /** Writes several params in one update; an undefined value clears its key. */
  setParams(patch: Record<string, unknown>): void;
  /** End the gesture: one undo step with this label. */
  commit(label: string): void;
}

export interface MaskParamScope extends ParamScope {
  maskId: string;
  /** Core local adjustments — relative strengths, all -100..100, 0 = none. */
  adj: MaskAdjustments;
  setAdj(patch: Partial<MaskAdjustments>): void;
  /** Structured blocks; present only while their sub-panel is added. */
  hsl: HSLAdjustments | undefined;
  setHsl(value: HSLAdjustments): void;
  toneCurve: ToneCurves | undefined;
  setToneCurve(value: ToneCurves): void;
  setParam(key: string, value: unknown): void;
}

const MaskScopeContext = createContext<MaskParamScope | null>(null);

const NO_PARAMS: Readonly<Record<string, unknown>> = {};

const withDefault = (bag: Readonly<Record<string, unknown>>, key: string): unknown =>
  bag[key] ?? getParamDescriptor(key)?.default;

function maskParams(maskId: string): Readonly<Record<string, unknown>> {
  return useDevelopStore.getState().params.masks.find((m) => m.id === maskId)?.bag ?? NO_PARAMS;
}

export function MaskScopeProvider({
  maskId,
  children,
}: {
  maskId: string;
  children: ReactNode;
}) {
  const mask = useDevelopStore((s) => s.params.masks.find((m) => m.id === maskId));
  const updateMask = useDevelopStore((s) => s.updateMask);
  const updateMaskAdj = useDevelopStore((s) => s.updateMaskAdj);
  const updateMaskBag = useDevelopStore((s) => s.updateMaskBag);
  const commitEdit = useDevelopStore((s) => s.commitEdit);

  const scope = useMemo<MaskParamScope | null>(() => {
    if (!mask) return null;
    return {
      maskId,
      adj: mask.adj,
      setAdj: (patch) => updateMaskAdj(maskId, patch),
      hsl: mask.hsl,
      setHsl: (hsl) => updateMask(maskId, { hsl }),
      toneCurve: mask.toneCurve,
      setToneCurve: (toneCurve) => updateMask(maskId, { toneCurve }),
      getParam: (key) => withDefault(maskParams(maskId), key),
      getParams: () => maskParams(maskId),
      setParam: (key, value) => updateMaskBag(maskId, { [key]: value }),
      setParams: (patch) => updateMaskBag(maskId, patch),
      commit: (label) => void commitEdit(label),
    };
  }, [mask, maskId, updateMask, updateMaskAdj, updateMaskBag, commitEdit]);

  // The mask can vanish while its editor is mounted (deleted / undone away).
  if (!scope) return null;
  return <MaskScopeContext.Provider value={scope}>{children}</MaskScopeContext.Provider>;
}

export function useMaskScope(): MaskParamScope {
  const scope = useContext(MaskScopeContext);
  if (!scope)
    throw new Error(
      "useMaskScope: no mask in scope — mask sub-panel components only render inside the Masking panel's Adjust tab",
    );
  return scope;
}

/** The scope a panel component edits: the mask's inside the Masking panel's
 *  Adjust tab, the photo's anywhere else. Lets one component be both a panel's
 *  `component` and its `mask.component`. */
export function useParamScope(): ParamScope {
  const mask = useContext(MaskScopeContext);
  // Subscribed so a write re-renders the component, which reads through the scope.
  const paramBag = useDevelopStore((s) => s.paramBag);
  const setDynParams = useDevelopStore((s) => s.setDynParams);
  const commitEdit = useDevelopStore((s) => s.commitEdit);
  const photo = useMemo<ParamScope>(
    () => ({
      maskId: null,
      getParam: (key) => withDefault(useDevelopStore.getState().paramBag, key),
      getParams: () => useDevelopStore.getState().paramBag,
      setParams: setDynParams,
      commit: (label) => void commitEdit(label),
    }),
    // A new bag hands the component a new scope, so a memo keyed on it reruns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paramBag, setDynParams, commitEdit],
  );
  return mask ?? photo;
}
