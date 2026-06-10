import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { CurveEditor } from "@/ui/components/CurveEditor";
import { HSLMixer } from "@/ui/components/HSLMixer";
import { useDevelopStore } from "@/state/develop-store";
import type { Mask, MaskAdjustments, MaskPanelId, MaskType } from "@/catalog/types";
import {
  MAX_MASKS,
  defaultHSL,
  defaultMaskAdjustments,
  defaultToneCurves,
} from "@/catalog/types";

const TOOL_LABELS: { type: MaskType; label: string }[] = [
  { type: "radial", label: "Radial" },
  { type: "linear", label: "Linear" },
  { type: "brush", label: "Brush" },
];

const TYPE_ICON: Record<MaskType, string> = {
  radial: "◯",
  linear: "▤",
  brush: "✎",
};

type SliderDef = { key: keyof MaskAdjustments; label: string };

// Sub-panels a mask can carry, mirroring the develop module's right-side
// panels. Slider panels write into mask.adj; "hsl" and "curve" carry their
// own data on the mask. Render order is fixed regardless of add order.
const PANEL_DEFS: { id: MaskPanelId; label: string; sliders?: SliderDef[] }[] = [
  {
    id: "basic",
    label: "Basic",
    sliders: [
      { key: "exposure", label: "Exposure" },
      { key: "contrast", label: "Contrast" },
      { key: "highlights", label: "Highlights" },
      { key: "shadows", label: "Shadows" },
      { key: "saturation", label: "Saturation" },
    ],
  },
  {
    id: "wb",
    label: "White Balance",
    sliders: [
      { key: "temperature", label: "Temp" },
      { key: "tint", label: "Tint" },
    ],
  },
  { id: "curve", label: "Tone Curve" },
  { id: "hsl", label: "HSL" },
  {
    id: "detail",
    label: "Detail",
    sliders: [
      { key: "clarity", label: "Clarity" },
      { key: "sharpness", label: "Sharpness" },
    ],
  },
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

  // Radial edge feather lives on the geometry; expose it 0..100 in the selected
  // section.
  const featherPct =
    selected?.type === "radial"
      ? Math.round((selected.radial?.feather ?? 0.5) * 100)
      : null;
  const setRadialFeather = (v: number) => {
    if (selected?.type === "radial" && selected.radial)
      updateMask(selected.id, { radial: { ...selected.radial, feather: v / 100 } });
  };

  // The brush's Feather is a tool setting that controls the brush, not any
  // existing mask. Painting stamps the current value onto the mask being drawn.
  const brushFeatherVal = Math.round(brushFeather * 100);
  const onBrushFeather = (v: number) => setBrushFeather(v / 100);

  const resetAdj = () => {
    if (!selected) return;
    updateMaskAdj(selected.id, defaultMaskAdjustments());
    updateMask(selected.id, {
      hsl: selected.panels.includes("hsl") ? defaultHSL() : undefined,
      toneCurve: selected.panels.includes("curve") ? defaultToneCurves() : undefined,
    });
    commitEdit("Mask Reset");
  };

  const addPanel = (id: MaskPanelId) => {
    if (!selected) return;
    updateMask(selected.id, {
      panels: [...selected.panels, id],
      ...(id === "hsl" ? { hsl: defaultHSL() } : {}),
      ...(id === "curve" ? { toneCurve: defaultToneCurves() } : {}),
    });
    commitEdit("Add Mask Panel");
  };

  // Removing a sub-panel also resets the values it controlled, so the render
  // matches what the user sees.
  const removePanel = (id: MaskPanelId) => {
    if (!selected) return;
    const def = PANEL_DEFS.find((d) => d.id === id);
    if (def?.sliders) {
      const zero: Partial<MaskAdjustments> = {};
      for (const s of def.sliders) zero[s.key] = 0;
      updateMaskAdj(selected.id, zero);
    }
    updateMask(selected.id, {
      panels: selected.panels.filter((p) => p !== id),
      ...(id === "hsl" ? { hsl: undefined } : {}),
      ...(id === "curve" ? { toneCurve: undefined } : {}),
    });
    commitEdit("Remove Mask Panel");
  };

  const pickTool = (t: MaskType) => {
    setMaskToolType(t);
    setActiveTool("mask");
  };

  // Clicking a mask row opens it for editing: select it and bring up its on-image
  // handles by activating the matching tool.
  const editMask = (m: Mask) => {
    selectMask(m.id);
    setMaskToolType(m.type);
    setActiveTool("mask");
  };

  const availablePanels = selected
    ? PANEL_DEFS.filter((d) => !selected.panels.includes(d.id))
    : [];

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
              {TYPE_ICON[t.type]} {t.label}
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
              value={brushFeatherVal}
              min={0}
              max={100}
              step={1}
              defaultValue={50}
              onChange={onBrushFeather}
            />
            <label className="flex items-center gap-1.5 px-0.5 text-[11px] text-text-secondary">
              <input
                type="checkbox"
                checked={brushErase}
                onChange={(e) => setBrushErase(e.target.checked)}
              />
              Erase
              <span className="text-text-muted">· hold Alt to erase · [ ] resize</span>
            </label>
          </div>
        )}

        {masks.length > 0 && (
          <div className="space-y-0.5">
            {masks.map((m) => (
              <div
                key={m.id}
                onClick={() => editMask(m)}
                className={`flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[11px] ${
                  m.id === selectedMaskId
                    ? "bg-accent/20 text-text-primary"
                    : "text-text-secondary hover:bg-surface-2"
                }`}
              >
                <span className="w-3 shrink-0 text-center text-text-muted">
                  {TYPE_ICON[m.type]}
                </span>
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
          <div className="space-y-1.5 border-t border-border-subtle pt-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-text-muted">
                {selected.name} adjustments
              </span>
              <button
                onClick={resetAdj}
                title="Reset this mask's adjustments"
                className="rounded px-1 text-[10px] text-text-muted hover:text-text-primary"
              >
                Reset
              </button>
            </div>
            <div className="space-y-0.5">
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
              {featherPct != null && (
                <Slider
                  label="Feather"
                  value={featherPct}
                  min={0}
                  max={100}
                  step={1}
                  defaultValue={50}
                  onChange={setRadialFeather}
                  onCommit={() => commitEdit("Mask Feather")}
                />
              )}
            </div>

            {PANEL_DEFS.filter((d) => selected.panels.includes(d.id)).map((def) => (
              <div key={def.id} className="rounded bg-surface-2/40 p-1.5">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-wider text-text-muted">
                    {def.label}
                  </span>
                  <button
                    onClick={() => removePanel(def.id)}
                    title={`Remove ${def.label} (resets its values)`}
                    className="rounded px-1 text-text-muted hover:text-label-red"
                  >
                    ×
                  </button>
                </div>
                {def.sliders && (
                  <div className="space-y-0.5">
                    {def.sliders.map((s) => (
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
                {def.id === "curve" && (
                  <CurveEditor
                    compact
                    curves={selected.toneCurve ?? defaultToneCurves()}
                    onChange={(channel, points) =>
                      updateMask(selected.id, {
                        toneCurve: {
                          ...(selected.toneCurve ?? defaultToneCurves()),
                          [channel]: points,
                        },
                      })
                    }
                    onCommit={() => commitEdit("Mask Tone Curve")}
                  />
                )}
                {def.id === "hsl" && (
                  <HSLMixer
                    value={selected.hsl ?? defaultHSL()}
                    onChange={(band, channel, v) => {
                      const h = selected.hsl ?? defaultHSL();
                      updateMask(selected.id, {
                        hsl: { ...h, [band]: { ...h[band], [channel]: v } },
                      });
                    }}
                    onCommit={(channel) => commitEdit(`Mask HSL ${channel}`)}
                  />
                )}
              </div>
            ))}

            {availablePanels.length > 0 && (
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-[10px] text-text-muted">Add:</span>
                {availablePanels.map((d) => (
                  <button
                    key={d.id}
                    onClick={() => addPanel(d.id)}
                    className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-secondary hover:text-text-primary"
                  >
                    + {d.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
