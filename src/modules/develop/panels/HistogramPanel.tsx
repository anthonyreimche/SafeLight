// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Live histogram with draggable tonal zones. Registered as an extension panel,
// so it renders both at the top of the Develop sidebar and as a floating
// dockable window (View ▸ Histogram).

import { useRef } from "react";
import { Histogram, type HistogramZone } from "@/ui/components/Histogram";
import { useDevelopStore } from "@/state/develop-store";
import { TONAL_PARAM_RANGE, type TonalParamKey } from "./tonal-params";

// Each histogram zone is a tonal param of the same name; dragging a zone adjusts
// it over ~300px of horizontal travel across its full range.
const ZONE_PARAM: Record<
  HistogramZone,
  { key: TonalParamKey; min: number; max: number }
> = {
  blacks: { key: "blacks", ...TONAL_PARAM_RANGE.blacks },
  shadows: { key: "shadows", ...TONAL_PARAM_RANGE.shadows },
  exposure: { key: "exposure", ...TONAL_PARAM_RANGE.exposure },
  highlights: { key: "highlights", ...TONAL_PARAM_RANGE.highlights },
  whites: { key: "whites", ...TONAL_PARAM_RANGE.whites },
};
const DRAG_REF_PX = 300;

// Isolated subscription so live histogram updates don't re-render the panels.
export function HistogramPanel() {
  const histogram = useDevelopStore((s) => s.histogram);
  const setParam = useDevelopStore((s) => s.setParam);
  const commitEdit = useDevelopStore((s) => s.commitEdit);
  const showClipping = useDevelopStore((s) => s.showClipping);
  const toggleClipping = useDevelopStore((s) => s.toggleClipping);
  const setShowClipping = useDevelopStore((s) => s.setShowClipping);

  const dragRef = useRef<{
    key: TonalParamKey;
    min: number;
    max: number;
    startValue: number;
  } | null>(null);
  const pendingRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  const apply = () => {
    const d = dragRef.current;
    if (d && pendingRef.current != null) {
      setParam(d.key, pendingRef.current);
      pendingRef.current = null;
    }
  };

  const onAdjust = (zone: HistogramZone, deltaPx: number, phase: string) => {
    if (phase === "start") {
      const cfg = ZONE_PARAM[zone];
      const startValue = useDevelopStore.getState().params[cfg.key] as number;
      dragRef.current = { ...cfg, startValue };
      return;
    }
    const d = dragRef.current;
    if (!d) return;
    if (phase === "end") {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      apply();
      dragRef.current = null;
      commitEdit("Histogram");
      return;
    }
    // move: coalesce store writes to one per frame.
    const range = d.max - d.min;
    const next = Math.min(
      d.max,
      Math.max(d.min, d.startValue + (deltaPx / DRAG_REF_PX) * range),
    );
    pendingRef.current = Number(next.toFixed(2));
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        apply();
      });
    }
  };

  const onReset = (zone: HistogramZone) => {
    const cfg = ZONE_PARAM[zone];
    setParam(cfg.key, 0);
    commitEdit("Histogram Reset");
  };

  return (
    <Histogram
      data={histogram}
      onAdjust={onAdjust}
      onReset={onReset}
      showClipping={showClipping}
      onToggleClipping={toggleClipping}
      onSetClipping={setShowClipping}
    />
  );
}
