import { CropPanel } from "./panels/CropPanel";
import { TransformPanel } from "./panels/TransformPanel";
import { WhiteBalancePanel } from "./panels/WhiteBalancePanel";
import { BasicPanel } from "./panels/BasicPanel";
import { ToneCurvePanel } from "./panels/ToneCurvePanel";
import { DetailPanel } from "./panels/DetailPanel";
import { HSLPanel } from "./panels/HSLPanel";
import { ColorGradingPanel } from "./panels/ColorGradingPanel";
import { LensCorrectionPanel } from "./panels/LensCorrectionPanel";
import { EffectsPanel } from "./panels/EffectsPanel";
import { PresetsPanel } from "./panels/PresetsPanel";
import { TuningPanel } from "./panels/TuningPanel";
import { useRef } from "react";
import type { DevelopParams } from "@/catalog/types";
import { Histogram, type HistogramZone } from "@/ui/components/Histogram";
import { useDevelopStore } from "@/state/develop-store";

export function DevelopSidebar() {
  const reset = useDevelopStore((s) => s.reset);
  const undo = useDevelopStore((s) => s.undo);
  const redo = useDevelopStore((s) => s.redo);
  const historyIndex = useDevelopStore((s) => s.historyIndex);
  const historyLength = useDevelopStore((s) => s.history.length);

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < historyLength - 1;

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
        <span className="text-[11px] uppercase tracking-wider text-text-secondary">
          Edit
        </span>
        <div className="flex gap-1">
          <button
            onClick={undo}
            disabled={!canUndo}
            className="rounded px-1.5 py-0.5 text-[11px] text-text-muted hover:text-text-primary disabled:cursor-default disabled:opacity-30 disabled:hover:text-text-muted"
            title="Undo"
          >
            {"↩"}
          </button>
          <button
            onClick={redo}
            disabled={!canRedo}
            className="rounded px-1.5 py-0.5 text-[11px] text-text-muted hover:text-text-primary disabled:cursor-default disabled:opacity-30 disabled:hover:text-text-muted"
            title="Redo"
          >
            {"↪"}
          </button>
          <button
            onClick={reset}
            className="rounded px-1.5 py-0.5 text-[11px] text-text-muted hover:text-text-primary"
            title="Reset"
          >
            Reset
          </button>
        </div>
      </div>
      <DevelopHistogram />
      <TuningPanel />
      <CropPanel />
      <TransformPanel />
      <WhiteBalancePanel />
      <BasicPanel />
      <ToneCurvePanel />
      <ColorGradingPanel />
      <DetailPanel />
      <LensCorrectionPanel />
      <EffectsPanel />
      <HSLPanel />
      <PresetsPanel />
    </div>
  );
}

// Histogram zones map to the tonal params; dragging a zone adjusts it. ~300px
// of horizontal drag spans the parameter's full range.
const ZONE_PARAM: Record<
  HistogramZone,
  { key: keyof DevelopParams; min: number; max: number }
> = {
  blacks: { key: "blacks", min: -100, max: 100 },
  shadows: { key: "shadows", min: -100, max: 100 },
  exposure: { key: "exposure", min: -5, max: 5 },
  highlights: { key: "highlights", min: -100, max: 100 },
  whites: { key: "whites", min: -100, max: 100 },
};
const DRAG_REF_PX = 300;

// Isolated subscription so live histogram updates don't re-render the panels.
function DevelopHistogram() {
  const histogram = useDevelopStore((s) => s.histogram);
  const setParam = useDevelopStore((s) => s.setParam);
  const commitEdit = useDevelopStore((s) => s.commitEdit);

  const dragRef = useRef<{
    key: keyof DevelopParams;
    min: number;
    max: number;
    startValue: number;
  } | null>(null);
  const pendingRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  const apply = () => {
    const d = dragRef.current;
    if (d && pendingRef.current != null) {
      setParam(d.key, pendingRef.current as never);
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
    setParam(cfg.key, 0 as never);
    commitEdit("Histogram Reset");
  };

  return <Histogram data={histogram} onAdjust={onAdjust} onReset={onReset} />;
}
