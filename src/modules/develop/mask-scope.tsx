// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Binds a mask sub-panel instance (PanelContribution.mask) to the mask it
// edits. The Masking panel wraps the selected mask's sub-panels in
// MaskScopeProvider; the components read and write ONLY through useMaskScope,
// never the global develop params — so a panel contribution serves both the
// dock (global scope, its own component) and any number of masks (one
// mask.component instance each). Core values land in mask.adj / mask.hsl /
// mask.toneCurve, which the shader's local-adjustment path applies; extension
// params land in mask.bag, which is persisted but not read by the GPU yet.

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { HSLAdjustments, MaskAdjustments, ToneCurves } from "@/catalog/types";
import { getParamDescriptor } from "@/extensions/param-registry";
import { useDevelopStore } from "@/state/develop-store";

export interface MaskParamScope {
  maskId: string;
  /** Core local adjustments — relative strengths, all -100..100, 0 = none. */
  adj: MaskAdjustments;
  setAdj(patch: Partial<MaskAdjustments>): void;
  /** Structured blocks; present only while their sub-panel is added. */
  hsl: HSLAdjustments | undefined;
  setHsl(value: HSLAdjustments): void;
  toneCurve: ToneCurves | undefined;
  setToneCurve(value: ToneCurves): void;
  /** Mask-scoped extension params by qualified key ("{stageId}.{key}"). Reads
   *  fall back to the param's registered default when the mask stores nothing. */
  getParam(key: string): unknown;
  setParam(key: string, value: unknown): void;
  /** End the gesture: one undo step with this label. */
  commit(label: string): void;
}

const MaskScopeContext = createContext<MaskParamScope | null>(null);

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
      getParam: (key) => mask.bag?.[key] ?? getParamDescriptor(key)?.default,
      setParam: (key, value) => updateMaskBag(maskId, { [key]: value }),
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
