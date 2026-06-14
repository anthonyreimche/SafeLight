import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { CurveEditor } from "@/ui/components/CurveEditor";
import { HSLMixer } from "@/ui/components/HSLMixer";
import { useDevelopStore } from "@/state/develop-store";
import type {
  Mask,
  MaskAdjustments,
  MaskComponent,
  MaskComponentKind,
  MaskComponentMode,
  MaskPanelId,
  MaskType,
} from "@/catalog/types";
import {
  MAX_MASKS,
  defaultColorRange,
  defaultHSL,
  defaultLuminanceRange,
  defaultMaskAdjustments,
  defaultToneCurves,
} from "@/catalog/types";

const TOOL_LABELS: { type: MaskType; label: string }[] = [
  { type: "radial", label: "Radial" },
  { type: "linear", label: "Linear" },
  { type: "brush", label: "Brush" },
];

const KIND_ICON: Record<MaskComponentKind, string> = {
  radial: "◯",
  linear: "▤",
  brush: "✎",
  luminance: "◐",
  color: "⬤",
};
const KIND_LABEL: Record<MaskComponentKind, string> = {
  radial: "Radial",
  linear: "Linear",
  brush: "Brush",
  luminance: "Luminance",
  color: "Color",
};

let idSeq = 0;
const genId = (p: string) => `${p}-${Date.now().toString(36)}-${idSeq++}`;

type SliderDef = { key: keyof MaskAdjustments; label: string };

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
  const maskCompMode = useDevelopStore((s) => s.maskCompMode);
  const masks = useDevelopStore((s) => s.params.masks);
  const selectedMaskId = useDevelopStore((s) => s.selectedMaskId);
  const selectedComponentId = useDevelopStore((s) => s.selectedComponentId);
  const brushSize = useDevelopStore((s) => s.brushSize);
  const brushFeather = useDevelopStore((s) => s.brushFeather);
  const brushErase = useDevelopStore((s) => s.brushErase);

  const setActiveTool = useDevelopStore((s) => s.setActiveTool);
  const setMaskToolType = useDevelopStore((s) => s.setMaskToolType);
  const setMaskCompMode = useDevelopStore((s) => s.setMaskCompMode);
  const setMaskAddTarget = useDevelopStore((s) => s.setMaskAddTarget);
  const selectMask = useDevelopStore((s) => s.selectMask);
  const selectComponent = useDevelopStore((s) => s.selectComponent);
  const removeMask = useDevelopStore((s) => s.removeMask);
  const updateMask = useDevelopStore((s) => s.updateMask);
  const updateMaskAdj = useDevelopStore((s) => s.updateMaskAdj);
  const addMask = useDevelopStore((s) => s.addMask);
  const addComponent = useDevelopStore((s) => s.addComponent);
  const updateComponent = useDevelopStore((s) => s.updateComponent);
  const removeComponent = useDevelopStore((s) => s.removeComponent);
  const commitEdit = useDevelopStore((s) => s.commitEdit);
  const setBrushSize = useDevelopStore((s) => s.setBrushSize);
  const setBrushFeather = useDevelopStore((s) => s.setBrushFeather);
  const setBrushErase = useDevelopStore((s) => s.setBrushErase);

  const masking = activeTool === "mask";
  const selected = masks.find((m) => m.id === selectedMaskId) ?? null;
  const selectedComp =
    selected?.components.find((c) => c.id === selectedComponentId) ?? null;

  // --- creation helpers ------------------------------------------------------
  // Arm a geometric tool. With a mask selected we extend it; otherwise the next
  // drag starts a fresh mask.
  const armTool = (t: MaskType, mode: MaskComponentMode) => {
    setMaskToolType(t);
    setMaskCompMode(mode);
    setMaskAddTarget(selected ? "current" : "new");
    setActiveTool("mask");
  };

  // Start a brand-new mask with a geometric tool.
  const newMaskTool = (t: MaskType) => {
    selectMask(null);
    setMaskToolType(t);
    setMaskCompMode("add");
    setMaskAddTarget("new");
    setActiveTool("mask");
  };

  // Range components have no on-canvas geometry, so add them immediately.
  const addRange = (kind: "luminance" | "color", mode: MaskComponentMode) => {
    const comp: MaskComponent = {
      id: genId("comp"),
      kind,
      mode,
      invert: false,
      ...(kind === "luminance"
        ? { luminance: defaultLuminanceRange() }
        : { color: defaultColorRange() }),
    };
    if (selected) {
      addComponent(selected.id, comp);
    } else {
      const id = genId("mask");
      const mask: Mask = {
        id,
        name: KIND_LABEL[kind],
        invert: false,
        opacity: 100,
        adj: defaultMaskAdjustments(),
        panels: ["basic"],
        components: [comp],
      };
      addMask(mask);
    }
    setActiveTool("mask");
    commitEdit("Add Mask Component");
  };

  // --- adjustment sub-panels (per mask) --------------------------------------
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

  const availablePanels = selected
    ? PANEL_DEFS.filter((d) => !selected.panels.includes(d.id))
    : [];

  const editComp = (m: Mask, c: MaskComponent) => {
    selectMask(m.id);
    selectComponent(c.id);
    if (c.kind === "radial" || c.kind === "linear" || c.kind === "brush") {
      setMaskToolType(c.kind);
      setMaskCompMode(c.mode);
      setMaskAddTarget("current");
      setActiveTool("mask");
    }
  };

  return (
    <Panel title="Masking" defaultOpen>
      <div className="space-y-2">
        {/* New-mask tools */}
        <div className="flex gap-1">
          {TOOL_LABELS.map((t) => (
            <button
              key={t.type}
              onClick={() => newMaskTool(t.type)}
              className={`flex-1 rounded px-1.5 py-1 text-[11px] ${
                masking && !selected && maskToolType === t.type
                  ? "bg-accent/30 text-text-primary"
                  : "bg-surface-2 text-text-secondary hover:text-text-primary"
              }`}
              title={`New ${t.label.toLowerCase()} mask`}
            >
              {KIND_ICON[t.type]} {t.label}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          <button
            onClick={() => addRange("luminance", "add")}
            className="flex-1 rounded bg-surface-2 px-1.5 py-1 text-[11px] text-text-secondary hover:text-text-primary"
            title="New luminance-range mask"
          >
            {KIND_ICON.luminance} Luminance
          </button>
          <button
            onClick={() => addRange("color", "add")}
            className="flex-1 rounded bg-surface-2 px-1.5 py-1 text-[11px] text-text-secondary hover:text-text-primary"
            title="New color-range mask"
          >
            {KIND_ICON.color} Color
          </button>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-[10px] text-text-muted">
            {masking
              ? maskToolType === "brush"
                ? `Paint to ${maskCompMode === "subtract" ? "subtract" : "add"}`
                : `Drag to ${maskCompMode === "subtract" ? "subtract" : "add"} a ${maskToolType}`
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
                style={{ accentColor: "var(--color-slider-fill)" }}
              />
              Erase
              <span className="text-text-muted">· Alt erase · [ ] size · ⇧[ ] feather</span>
            </label>
          </div>
        )}

        {/* Mask list */}
        {masks.length > 0 && (
          <div className="space-y-0.5">
            {masks.map((m) => {
              const k = m.components[0]?.kind ?? "brush";
              const sel = m.id === selectedMaskId;
              return (
                <div
                  key={m.id}
                  onClick={() => {
                    selectMask(m.id);
                    selectComponent(m.components[0]?.id ?? null);
                  }}
                  className={`flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[11px] ${
                    sel ? "bg-accent/20 text-text-primary" : "text-text-secondary hover:bg-surface-2"
                  }`}
                >
                  <span className="w-3 shrink-0 text-center text-text-muted">{KIND_ICON[k]}</span>
                  <span className="flex-1 truncate">
                    {m.name}
                    <span className="text-text-muted">
                      {" "}
                      ({m.components.length})
                    </span>
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      updateMask(m.id, { invert: !m.invert });
                      commitEdit("Mask Invert");
                    }}
                    title="Invert whole mask"
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
                    title="Delete mask"
                    className="rounded px-1 text-text-muted hover:text-label-red"
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Selected mask: components + add/subtract + adjustments */}
        {selected && (
          <div className="space-y-1.5 border-t border-border-subtle pt-2">
            {/* Component list */}
            <div className="space-y-0.5">
              <span className="text-[10px] uppercase tracking-wider text-text-muted">
                Components
              </span>
              {selected.components.map((c) => {
                const sel = c.id === selectedComponentId;
                const sub = c.mode === "subtract";
                return (
                  <div
                    key={c.id}
                    onClick={() => editComp(selected, c)}
                    className={`flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[11px] ${
                      sel ? "bg-accent/20 text-text-primary" : "text-text-secondary hover:bg-surface-2"
                    }`}
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        updateComponent(selected.id, c.id, {
                          mode: sub ? "add" : "subtract",
                        });
                        commitEdit("Component Mode");
                      }}
                      title={sub ? "Subtract — click for Add" : "Add — click for Subtract"}
                      className={`w-4 shrink-0 rounded text-center font-bold ${
                        sub ? "text-label-yellow" : "text-accent"
                      }`}
                    >
                      {sub ? "−" : "+"}
                    </button>
                    <span className="w-3 shrink-0 text-center text-text-muted">
                      {KIND_ICON[c.kind]}
                    </span>
                    <span className="flex-1 truncate">{KIND_LABEL[c.kind]}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        updateComponent(selected.id, c.id, { invert: !c.invert });
                        commitEdit("Component Invert");
                      }}
                      title="Invert this component"
                      className={`rounded px-1 ${c.invert ? "text-accent" : "text-text-muted hover:text-text-primary"}`}
                    >
                      ⊘
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeComponent(selected.id, c.id);
                        commitEdit("Delete Component");
                      }}
                      title="Delete component"
                      className="rounded px-1 text-text-muted hover:text-label-red"
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Add / Subtract rows */}
            {(["add", "subtract"] as MaskComponentMode[]).map((mode) => (
              <div key={mode} className="flex flex-wrap items-center gap-1">
                <span
                  className={`text-[10px] font-semibold ${mode === "subtract" ? "text-label-yellow" : "text-accent"}`}
                >
                  {mode === "subtract" ? "Subtract:" : "Add:"}
                </span>
                {TOOL_LABELS.map((t) => (
                  <button
                    key={t.type}
                    onClick={() => armTool(t.type, mode)}
                    className={`rounded px-1.5 py-0.5 text-[10px] ${
                      masking && maskToolType === t.type && maskCompMode === mode
                        ? "bg-accent/30 text-text-primary"
                        : "bg-surface-2 text-text-secondary hover:text-text-primary"
                    }`}
                  >
                    {KIND_ICON[t.type]} {t.label}
                  </button>
                ))}
                <button
                  onClick={() => addRange("luminance", mode)}
                  className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-secondary hover:text-text-primary"
                >
                  {KIND_ICON.luminance} Lum
                </button>
                <button
                  onClick={() => addRange("color", mode)}
                  className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-secondary hover:text-text-primary"
                >
                  {KIND_ICON.color} Color
                </button>
              </div>
            ))}

            {/* Selected-component geometry controls */}
            {selectedComp && (
              <ComponentControls
                key={selectedComp.id}
                maskId={selected.id}
                comp={selectedComp}
                updateComponent={updateComponent}
                commitEdit={commitEdit}
              />
            )}

            {/* Per-mask adjustments */}
            <div className="flex items-center justify-between pt-1">
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
                <span className="text-[10px] text-text-muted">Adjust:</span>
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

// Geometry/range controls for the selected component.
function ComponentControls({
  maskId,
  comp,
  updateComponent,
  commitEdit,
}: {
  maskId: string;
  comp: MaskComponent;
  updateComponent: (maskId: string, compId: string, patch: Partial<MaskComponent>) => void;
  commitEdit: (label: string) => void;
}) {
  if (comp.kind === "radial" && comp.radial) {
    const r = comp.radial;
    return (
      <div className="rounded bg-surface-2/40 p-1.5">
        <Slider
          label="Feather"
          value={Math.round(r.feather * 100)}
          min={0}
          max={100}
          step={1}
          defaultValue={50}
          onChange={(v) => updateComponent(maskId, comp.id, { radial: { ...r, feather: v / 100 } })}
          onCommit={() => commitEdit("Mask Feather")}
        />
      </div>
    );
  }
  if (comp.kind === "luminance" && comp.luminance) {
    const g = comp.luminance;
    return (
      <div className="space-y-0.5 rounded bg-surface-2/40 p-1.5">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">Luminance range</span>
        <Slider label="Low" value={Math.round(g.lo * 100)} min={0} max={100} step={1} defaultValue={25}
          onChange={(v) => updateComponent(maskId, comp.id, { luminance: { ...g, lo: Math.min(v / 100, g.hi) } })}
          onCommit={() => commitEdit("Lum Range")} />
        <Slider label="High" value={Math.round(g.hi * 100)} min={0} max={100} step={1} defaultValue={75}
          onChange={(v) => updateComponent(maskId, comp.id, { luminance: { ...g, hi: Math.max(v / 100, g.lo) } })}
          onCommit={() => commitEdit("Lum Range")} />
        <Slider label="Smoothness" value={Math.round(g.feather * 100)} min={0} max={50} step={1} defaultValue={10}
          onChange={(v) => updateComponent(maskId, comp.id, { luminance: { ...g, feather: v / 100 } })}
          onCommit={() => commitEdit("Lum Range")} />
      </div>
    );
  }
  if (comp.kind === "color" && comp.color) {
    const g = comp.color;
    return (
      <div className="space-y-0.5 rounded bg-surface-2/40 p-1.5">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">Color range</span>
        <Slider label="Hue" value={Math.round(g.hue * 360)} min={0} max={360} step={1} defaultValue={180}
          onChange={(v) => updateComponent(maskId, comp.id, { color: { ...g, hue: v / 360 } })}
          onCommit={() => commitEdit("Color Range")} />
        <Slider label="Hue range" value={Math.round(g.hueTol * 100)} min={1} max={50} step={1} defaultValue={8}
          onChange={(v) => updateComponent(maskId, comp.id, { color: { ...g, hueTol: v / 100 } })}
          onCommit={() => commitEdit("Color Range")} />
        <Slider label="Sat range" value={Math.round(g.satTol * 100)} min={1} max={100} step={1} defaultValue={50}
          onChange={(v) => updateComponent(maskId, comp.id, { color: { ...g, satTol: v / 100 } })}
          onCommit={() => commitEdit("Color Range")} />
        <Slider label="Smoothness" value={Math.round(g.feather * 100)} min={0} max={50} step={1} defaultValue={5}
          onChange={(v) => updateComponent(maskId, comp.id, { color: { ...g, feather: v / 100 } })}
          onCommit={() => commitEdit("Color Range")} />
      </div>
    );
  }
  return null;
}
