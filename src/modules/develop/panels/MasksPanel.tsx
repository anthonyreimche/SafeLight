import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { useDevelopStore } from "@/state/develop-store";
import type { MaskAdjustments, MaskType } from "@/catalog/types";
import { MAX_MASKS } from "@/catalog/types";

const TOOL_LABELS: { type: MaskType; label: string }[] = [
  { type: "radial", label: "Radial" },
  { type: "linear", label: "Linear" },
  { type: "brush", label: "Brush" },
];

const ADJ_SLIDERS: { key: keyof MaskAdjustments; label: string }[] = [
  { key: "exposure", label: "Exposure" },
  { key: "contrast", label: "Contrast" },
  { key: "highlights", label: "Highlights" },
  { key: "shadows", label: "Shadows" },
  { key: "temperature", label: "Temp" },
  { key: "tint", label: "Tint" },
  { key: "saturation", label: "Saturation" },
  { key: "clarity", label: "Clarity" },
  { key: "sharpness", label: "Sharpness" },
];

export function MasksPanel() {
  const activeTool = useDevelopStore((s) => s.activeTool);
  const maskToolType = useDevelopStore((s) => s.maskToolType);
  const masks = useDevelopStore((s) => s.params.masks);
  const selectedMaskId = useDevelopStore((s) => s.selectedMaskId);
  const brushSize = useDevelopStore((s) => s.brushSize);
  const brushFeather = useDevelopStore((s) => s.brushFeather);
  const brushErase = useDevelopStore((s) => s.brushErase);

  const setActiveTool = useDevelopStore((s) => s.setActiveTool);
  const setMaskToolType = useDevelopStore((s) => s.setMaskToolType);
  const selectMask = useDevelopStore((s) => s.selectMask);
  const removeMask = useDevelopStore((s) => s.removeMask);
  const updateMask = useDevelopStore((s) => s.updateMask);
  const updateMaskAdj = useDevelopStore((s) => s.updateMaskAdj);
  const commitEdit = useDevelopStore((s) => s.commitEdit);
  const setBrushSize = useDevelopStore((s) => s.setBrushSize);
  const setBrushFeather = useDevelopStore((s) => s.setBrushFeather);
  const setBrushErase = useDevelopStore((s) => s.setBrushErase);

  const masking = activeTool === "mask";
  const selected = masks.find((m) => m.id === selectedMaskId) ?? null;

  const pickTool = (t: MaskType) => {
    setMaskToolType(t);
    setActiveTool("mask");
  };

  return (
    <Panel title="Masking" defaultOpen>
      <div className="space-y-2">
        <div className="flex gap-1">
          {TOOL_LABELS.map((t) => (
            <button
              key={t.type}
              onClick={() => pickTool(t.type)}
              className={`flex-1 rounded px-1.5 py-1 text-[11px] ${
                masking && maskToolType === t.type
                  ? "bg-accent/30 text-text-primary"
                  : "bg-surface-2 text-text-secondary hover:text-text-primary"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between">
          <span className="text-[10px] text-text-muted">
            {masking
              ? maskToolType === "brush"
                ? "Paint on the image"
                : `Drag to add a ${maskToolType} mask`
              : `${masks.length}/${MAX_MASKS} masks`}
          </span>
          {masking && (
            <button
              onClick={() => setActiveTool("none")}
              className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-text-secondary hover:text-text-primary"
            >
              Done
            </button>
          )}
        </div>

        {masking && maskToolType === "brush" && (
          <div className="space-y-0.5 rounded bg-surface-2/50 p-1.5">
            <Slider
              label="Size"
              value={Math.round(brushSize * 100)}
              min={1}
              max={50}
              step={1}
              defaultValue={8}
              onChange={(v) => setBrushSize(v / 100)}
            />
            <Slider
              label="Feather"
              value={Math.round(brushFeather * 100)}
              min={0}
              max={100}
              step={1}
              defaultValue={50}
              onChange={(v) => setBrushFeather(v / 100)}
            />
            <label className="flex items-center gap-1.5 px-0.5 text-[11px] text-text-secondary">
              <input
                type="checkbox"
                checked={brushErase}
                onChange={(e) => setBrushErase(e.target.checked)}
              />
              Erase
            </label>
          </div>
        )}

        {masks.length > 0 && (
          <div className="space-y-0.5">
            {masks.map((m) => (
              <div
                key={m.id}
                onClick={() => selectMask(m.id)}
                className={`flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[11px] ${
                  m.id === selectedMaskId
                    ? "bg-accent/20 text-text-primary"
                    : "text-text-secondary hover:bg-surface-2"
                }`}
              >
                <span className="flex-1 truncate">
                  {m.name}
                  {m.type === "brush" ? ` (${m.brush?.dabs.length ?? 0})` : ""}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    updateMask(m.id, { invert: !m.invert });
                    commitEdit("Mask Invert");
                  }}
                  title="Invert"
                  className={`rounded px-1 ${m.invert ? "text-accent" : "text-text-muted hover:text-text-primary"}`}
                >
                  ⊘
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeMask(m.id);
                    commitEdit("Delete Mask");
                  }}
                  title="Delete"
                  className="rounded px-1 text-text-muted hover:text-label-red"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {selected && (
          <div className="space-y-0.5 border-t border-border-subtle pt-2">
            <div className="pb-1 text-[10px] uppercase tracking-wider text-text-muted">
              {selected.name} adjustments
            </div>
            <Slider
              label="Amount"
              value={selected.opacity}
              min={0}
              max={100}
              step={1}
              defaultValue={100}
              onChange={(v) => updateMask(selected.id, { opacity: v })}
              onCommit={() => commitEdit("Mask Amount")}
            />
            {ADJ_SLIDERS.map((s) => (
              <Slider
                key={s.key}
                label={s.label}
                value={selected.adj[s.key]}
                min={-100}
                max={100}
                step={1}
                defaultValue={0}
                onChange={(v) => updateMaskAdj(selected.id, { [s.key]: v })}
                onCommit={() => commitEdit(`Mask ${s.label}`)}
              />
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}
