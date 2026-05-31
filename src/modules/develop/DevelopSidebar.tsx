import { MetadataPanel } from "./panels/MetadataPanel";
import { CropPanel } from "./panels/CropPanel";
import { WhiteBalancePanel } from "./panels/WhiteBalancePanel";
import { BasicPanel } from "./panels/BasicPanel";
import { ToneCurvePanel } from "./panels/ToneCurvePanel";
import { HSLPanel } from "./panels/HSLPanel";
import { PresetsPanel } from "./panels/PresetsPanel";
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
      <MetadataPanel />
      <CropPanel />
      <WhiteBalancePanel />
      <BasicPanel />
      <ToneCurvePanel />
      <HSLPanel />
      <PresetsPanel />
    </div>
  );
}
