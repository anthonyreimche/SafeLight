// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { type MouseEvent as ReactMouseEvent, useState } from "react";
import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { useDevelopStore } from "@/state/develop-store";
import { useKeyboardCanvasEditing } from "@/state/accessibility";
import { useRegistry, type RegisteredPanel } from "@/extensions/registry";
import type { MaskPanelContribution } from "@/extensions/types";
import { MaskScopeProvider } from "@/modules/develop/mask-scope";
import type {
  Mask,
  MaskComponent,
  MaskComponentKind,
  MaskComponentMode,
  MaskType,
} from "@/catalog/types";
import { MAX_MASKS, defaultMaskAdjustments } from "@/catalog/types";

// Tools that create a component by dragging on the canvas.
const GEO_TOOLS: { type: MaskType; label: string }[] = [
  { type: "radial", label: "Radial" },
  { type: "linear", label: "Linear" },
  { type: "brush", label: "Brush" },
];
// Parametric ranges: created instantly (no canvas drag).
const RANGE_TOOLS: { kind: "lumRange" | "colorRange"; label: string }[] = [
  { kind: "lumRange", label: "Luminance Range" },
  { kind: "colorRange", label: "Color Range" },
];

const KIND_ICON: Record<MaskComponentKind, string> = {
  radial: "◯",
  linear: "▤",
  brush: "✎",
  lumRange: "◐",
  colorRange: "⬤",
};
const KIND_LABEL: Record<MaskComponentKind, string> = {
  radial: "Radial",
  linear: "Linear",
  brush: "Brush",
  lumRange: "Luminance",
  colorRange: "Color",
};

// Mode chip glyph + colour. add = union, subtract = carve, intersect = confine.
const MODE_GLYPH: Record<MaskComponentMode, string> = {
  add: "+",
  subtract: "−",
  intersect: "∩",
};
const MODE_CLASS: Record<MaskComponentMode, string> = {
  add: "text-accent",
  subtract: "text-label-yellow",
  intersect: "text-label-blue",
};
const MODE_TITLE: Record<MaskComponentMode, string> = {
  add: "Add (union) — click to cycle",
  subtract: "Subtract (carve) — click to cycle",
  intersect: "Intersect (confine) — click to cycle",
};

// A mask's adjustment UI is not defined here: any registered panel that
// declares a per-mask variant (PanelContribution.mask) can be added to a mask,
// and each mask renders its own instance of that panel bound to the mask via
// MaskScopeProvider. Core Basic/WB/Curve/HSL/Detail register variants; so can
// extensions.
type MaskPanelDef = RegisteredPanel & { mask: MaskPanelContribution };

function maskPanelDefs(panels: Record<string, RegisteredPanel>): MaskPanelDef[] {
  return Object.values(panels)
    .filter((p): p is MaskPanelDef => !!p.mask)
    .sort(
      (a, b) =>
        (a.mask.order ?? 100) - (b.mask.order ?? 100) ||
        a.title.localeCompare(b.title),
    );
}

// One active sub-panel card: header (title + remove) around the contribution's
// per-mask component, which talks to the mask through the surrounding scope.
function MaskSubPanel({
  def,
  onRemove,
}: {
  def: MaskPanelDef;
  onRemove: () => void;
}) {
  const Body = def.mask.component;
  return (
    <div className="rounded bg-surface-2/40 p-1.5">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">
          {def.title}
        </span>
        <button
          onClick={onRemove}
          title={`Remove ${def.title} (resets its values)`}
          className="rounded px-1 text-text-muted hover:text-label-red"
        >
          ×
        </button>
      </div>
      <Body />
    </div>
  );
}

export function MasksPanel() {
  const activeTool = useDevelopStore((s) => s.activeTool);
  const maskToolType = useDevelopStore((s) => s.maskToolType);
  const maskCompMode = useDevelopStore((s) => s.maskCompMode);
  const masks = useDevelopStore((s) => s.params.masks);
  const selectedMaskId = useDevelopStore((s) => s.selectedMaskId);
  const selectedComponentId = useDevelopStore((s) => s.selectedComponentId);
  const brushSize = useDevelopStore((s) => s.brushSize);
  const brushFeather = useDevelopStore((s) => s.brushFeather);
  const brushOpacity = useDevelopStore((s) => s.brushOpacity);
  const brushFlow = useDevelopStore((s) => s.brushFlow);
  const brushErase = useDevelopStore((s) => s.brushErase);

  const setActiveTool = useDevelopStore((s) => s.setActiveTool);
  const setMaskToolType = useDevelopStore((s) => s.setMaskToolType);
  const setMaskCompMode = useDevelopStore((s) => s.setMaskCompMode);
  const setMaskAddTarget = useDevelopStore((s) => s.setMaskAddTarget);
  const selectMask = useDevelopStore((s) => s.selectMask);
  const selectComponent = useDevelopStore((s) => s.selectComponent);
  const setHoveredMaskId = useDevelopStore((s) => s.setHoveredMaskId);
  const removeMask = useDevelopStore((s) => s.removeMask);
  const renameMask = useDevelopStore((s) => s.renameMask);
  const updateMask = useDevelopStore((s) => s.updateMask);
  const updateMaskAdj = useDevelopStore((s) => s.updateMaskAdj);
  const seedMaskPanelValues = useDevelopStore((s) => s.seedMaskPanelValues);
  const clearMaskPanelValues = useDevelopStore((s) => s.clearMaskPanelValues);
  const registryPanels = useRegistry((s) => s.panels);
  const updateComponent = useDevelopStore((s) => s.updateComponent);
  const removeComponent = useDevelopStore((s) => s.removeComponent);
  const cycleComponentMode = useDevelopStore((s) => s.cycleComponentMode);
  const addRangeComponent = useDevelopStore((s) => s.addRangeComponent);
  const commitEdit = useDevelopStore((s) => s.commitEdit);
  const setBrushSize = useDevelopStore((s) => s.setBrushSize);
  const setBrushFeather = useDevelopStore((s) => s.setBrushFeather);
  const setBrushOpacity = useDevelopStore((s) => s.setBrushOpacity);
  const setBrushFlow = useDevelopStore((s) => s.setBrushFlow);
  const setBrushErase = useDevelopStore((s) => s.setBrushErase);
  const tab = useDevelopStore((s) => s.maskTab);
  const setTab = useDevelopStore((s) => s.setMaskTab);
  const setBrushPreview = useDevelopStore((s) => s.setBrushPreview);

  const masking = activeTool === "mask";
  // addMask no-ops at the cap, so the "Create Mask" entry point is disabled
  // there — otherwise a range mask would push an empty "New Mask" history entry.
  const atMaskCap = masks.length >= MAX_MASKS;
  const selected = masks.find((m) => m.id === selectedMaskId) ?? null;
  const selectedComp =
    selected?.components.find((c) => c.id === selectedComponentId) ?? null;

  const [addOpen, setAddOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

  // --- creation helpers ------------------------------------------------------
  // Arm a geometric tool to extend the selected mask (or start fresh if none).
  const armTool = (t: MaskType, mode: MaskComponentMode) => {
    setMaskToolType(t);
    setMaskCompMode(mode);
    setMaskAddTarget(selected ? "current" : "new");
    setActiveTool("mask");
  };

  // Start a brand-new mask with a geometric tool (drag on canvas to draw).
  const newMaskTool = (t: MaskType) => {
    selectMask(null);
    setMaskToolType(t);
    setMaskCompMode("add");
    setMaskAddTarget("new");
    setActiveTool("mask");
  };

  // "Create Mask" menu: a fresh mask of any kind.
  const createMask = (kind: MaskComponentKind) => {
    setCreateOpen(false);
    setTab("coverage");
    if (kind === "lumRange" || kind === "colorRange") {
      selectMask(null);
      addRangeComponent(kind);
      commitEdit("New Mask");
    } else {
      newMaskTool(kind);
    }
  };

  // "+ Add" menu: append a component to the selected mask.
  const addToSelected = (kind: MaskComponentKind) => {
    setAddOpen(false);
    if (kind === "lumRange" || kind === "colorRange") {
      addRangeComponent(kind);
      commitEdit("Add Component");
    } else {
      // Deselect first so the next stroke starts a fresh component instead of
      // extending the selected one — this is how a mask gets multiple brushes.
      // Draw in "add" mode; the per-row mode chip flips it to subtract/intersect.
      selectComponent(null);
      armTool(kind, "add");
    }
  };

  // --- adjustment sub-panels (per mask) --------------------------------------
  const panelDefs = maskPanelDefs(registryPanels);
  const activeDefs = selected
    ? panelDefs.filter((d) => selected.panels.includes(d.id))
    : [];
  // Ids with no registered per-mask variant (the owning extension is disabled
  // or gone). Kept in the list — with values preserved — so they survive a
  // round-trip; shown as removable placeholders.
  const orphanedIds = selected
    ? selected.panels.filter((id) => !registryPanels[id]?.mask)
    : [];

  const resetAdj = () => {
    if (!selected) return;
    // Blanket-reset the core adjustments (covers legacy stragglers whose
    // sub-panel was removed), then re-seed each active sub-panel's defaults.
    // Orphaned sub-panels keep their values: their owner isn't here to ask.
    updateMaskAdj(selected.id, defaultMaskAdjustments());
    for (const def of activeDefs) seedMaskPanelValues(selected.id, def.mask.owns);
    commitEdit("Mask Reset");
  };
  const addPanel = (def: MaskPanelDef) => {
    if (!selected) return;
    seedMaskPanelValues(selected.id, def.mask.owns);
    updateMask(selected.id, { panels: [...selected.panels, def.id] });
    commitEdit("Add Mask Panel");
  };
  const removePanel = (id: string) => {
    if (!selected) return;
    const def = registryPanels[id];
    if (def?.mask) clearMaskPanelValues(selected.id, def.mask.owns);
    updateMask(selected.id, { panels: selected.panels.filter((p) => p !== id) });
    commitEdit("Remove Mask Panel");
  };

  const availablePanels = selected
    ? panelDefs.filter((d) => !selected.panels.includes(d.id))
    : [];

  const editComp = (m: Mask, c: MaskComponent) => {
    selectMask(m.id);
    selectComponent(c.id);
    if (c.kind === "radial" || c.kind === "linear" || c.kind === "brush") {
      setMaskToolType(c.kind);
      setMaskCompMode(c.mode === "subtract" ? "subtract" : "add");
      setMaskAddTarget("current");
      setActiveTool("mask");
    }
  };

  // Distinct component kinds in a mask, for the list-row icon summary.
  const kindSummary = (m: Mask): MaskComponentKind[] => {
    const seen: MaskComponentKind[] = [];
    for (const c of m.components) if (!seen.includes(c.kind)) seen.push(c.kind);
    return seen;
  };

  // Clicking empty panel space (not a row/button, which sit on child elements)
  // deselects the current mask, collapsing its editor.
  const deselectOnBackground = (e: ReactMouseEvent) => {
    if (e.target !== e.currentTarget) return;
    selectMask(null);
    selectComponent(null);
    setHoveredMaskId(null);
  };

  return (
    <Panel title="Masking" defaultOpen>
      <div className="space-y-2" onClick={deselectOnBackground}>
        {/* Create new mask */}
        <div className="relative">
          <button
            onClick={() => {
              setCreateOpen((v) => !v);
              setAddOpen(false);
            }}
            disabled={atMaskCap}
            title={atMaskCap ? `Mask limit reached (${MAX_MASKS})` : undefined}
            className="flex w-full items-center justify-center gap-1 rounded bg-surface-2 px-2 py-1.5 text-[11px] text-text-secondary hover:text-text-primary disabled:cursor-default disabled:opacity-40"
          >
            + Create Mask ▾
          </button>
          {createOpen && (
            <ToolMenu
              onPick={(k) => createMask(k)}
              onClose={() => setCreateOpen(false)}
            />
          )}
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
              onClick={() => {
                setActiveTool("none");
                // Deselect so the list collapses and the coverage overlay clears.
                selectMask(null);
                selectComponent(null);
                setHoveredMaskId(null);
              }}
              className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-text-secondary hover:text-text-primary"
            >
              Done
            </button>
          )}
        </div>

        {/* Brush settings — available while the brush tool is active, including
            before the first stroke of a new brush mask. */}
        {masking && maskToolType === "brush" && (
          <div className="space-y-0.5 rounded bg-surface-2/50 p-1.5">
            <Slider
              label="Size"
              value={Math.round(brushSize * 100)}
              min={1}
              max={50}
              step={1}
              defaultValue={8}
              onChange={(v) => {
                setBrushSize(v / 100);
                setBrushPreview(true);
              }}
              onCommit={() => setBrushPreview(false)}
            />
            <Slider
              label="Feather"
              value={Math.round(brushFeather * 100)}
              min={0}
              max={100}
              step={1}
              defaultValue={50}
              onChange={(v) => {
                setBrushFeather(v / 100);
                setBrushPreview(true);
              }}
              onCommit={() => setBrushPreview(false)}
            />
            <Slider
              label="Opacity"
              value={Math.round(brushOpacity * 100)}
              min={1}
              max={100}
              step={1}
              defaultValue={100}
              onChange={(v) => {
                setBrushOpacity(v / 100);
                setBrushPreview(true);
              }}
              onCommit={() => setBrushPreview(false)}
            />
            <Slider
              label="Flow"
              value={Math.round(brushFlow * 100)}
              min={1}
              max={100}
              step={1}
              defaultValue={100}
              onChange={(v) => {
                setBrushFlow(v / 100);
                setBrushPreview(true);
              }}
              onCommit={() => setBrushPreview(false)}
            />
            <label className="flex items-center gap-1.5 px-0.5 text-[11px] text-text-secondary">
              <input
                type="checkbox"
                checked={brushErase}
                onChange={(e) => setBrushErase(e.target.checked)}
                style={{ accentColor: "var(--color-slider-fill)" }}
              />
              Erase
              <span className="text-text-muted">· Alt erase · [ ] size · ⇧ feather · , . opacity · ⇧, ⇧. flow</span>
            </label>
          </div>
        )}

        {/* Mask list (layer rows) */}
        {masks.length > 0 && (
          <div className="space-y-0.5" onClick={deselectOnBackground}>
            {masks.map((m) => {
              const sel = m.id === selectedMaskId;
              return (
                <div
                  key={m.id}
                  onClick={() => {
                    selectMask(m.id);
                    selectComponent(m.components[0]?.id ?? null);
                    setTab("coverage");
                  }}
                  onMouseEnter={() => setHoveredMaskId(m.id)}
                  onMouseLeave={() => setHoveredMaskId(null)}
                  className={`group flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[11px] ${
                    sel ? "bg-accent/20 text-text-primary" : "text-text-secondary hover:bg-surface-2"
                  } ${m.visible === false ? "opacity-50" : ""}`}
                >
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      updateMask(m.id, { visible: m.visible === false });
                      commitEdit("Mask Visibility");
                    }}
                    // Hovering the visibility toggle shouldn't preview coverage.
                    onMouseEnter={() => setHoveredMaskId(null)}
                    onMouseLeave={() => setHoveredMaskId(m.id)}
                    title={m.visible !== false ? "Hide" : "Show"}
                    className={`shrink-0 rounded px-0.5 ${
                      m.visible !== false
                        ? "text-text-muted hover:text-text-primary"
                        : "text-text-muted/40 hover:text-text-primary"
                    }`}
                  >
                    {m.visible !== false ? "◉" : "○"}
                  </button>
                  <span className="shrink-0 text-text-muted">
                    {kindSummary(m).map((k) => KIND_ICON[k]).join(" ")}
                  </span>
                  {renaming?.id === m.id ? (
                    <input
                      autoFocus
                      value={renaming.value}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenaming({ id: m.id, value: e.target.value })}
                      onBlur={() => {
                        const v = renaming.value.trim();
                        if (v) renameMask(m.id, v);
                        setRenaming(null);
                        commitEdit("Rename Mask");
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      className="min-w-0 flex-1 rounded bg-surface-3 px-1 text-[11px] text-text-primary outline-none"
                    />
                  ) : (
                    <span
                      className="flex-1 truncate"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setRenaming({ id: m.id, value: m.name });
                      }}
                    >
                      {m.name}
                      <span className="text-text-muted"> ({m.components.length})</span>
                    </span>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      updateMask(m.id, { invert: !m.invert });
                      commitEdit("Mask Invert");
                    }}
                    title="Invert whole mask"
                    className={`rounded px-1 ${m.invert ? "text-accent" : "text-text-muted opacity-0 hover:text-text-primary group-hover:opacity-100"}`}
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
                    aria-label="Delete mask"
                    className="rounded px-1 text-text-muted opacity-0 hover:text-label-red group-hover:opacity-100"
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Selected mask editor: Coverage / Adjust tabs */}
        {selected && (
          <div className="space-y-2 border-t border-border-subtle pt-2">
            <div className="flex gap-1 rounded bg-surface-2 p-0.5">
              {(["coverage", "adjust"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`flex-1 rounded px-2 py-1 text-[11px] capitalize ${
                    tab === t
                      ? "bg-accent/30 text-text-primary"
                      : "text-text-secondary hover:text-text-primary"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>

            {tab === "coverage" ? (
              <div className="space-y-1.5">
                {/* Component stack */}
                <div className="space-y-0.5">
                  {selected.components.map((c) => {
                    const sel = c.id === selectedComponentId;
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
                            cycleComponentMode(selected.id, c.id);
                            commitEdit("Component Mode");
                          }}
                          title={MODE_TITLE[c.mode]}
                          className={`w-4 shrink-0 rounded text-center font-bold ${MODE_CLASS[c.mode]}`}
                        >
                          {MODE_GLYPH[c.mode]}
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
                          aria-label="Delete component"
                          className="rounded px-1 text-text-muted hover:text-label-red"
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>

                {/* Add component to this mask */}
                <div className="relative">
                  <button
                    onClick={() => {
                      setAddOpen((v) => !v);
                      setCreateOpen(false);
                    }}
                    className="flex w-full items-center justify-center gap-1 rounded bg-surface-2 px-2 py-1 text-[10px] text-text-secondary hover:text-text-primary"
                  >
                    + Add Component ▾
                  </button>
                  {addOpen && (
                    <ToolMenu onPick={(k) => addToSelected(k)} onClose={() => setAddOpen(false)} />
                  )}
                </div>

                {/* Selected-component geometry / range controls */}
                {selectedComp && (
                  <ComponentControls
                    key={selectedComp.id}
                    maskId={selected.id}
                    comp={selectedComp}
                  />
                )}
              </div>
            ) : (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-wider text-text-muted">
                    Amount
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
                  label="Opacity"
                  value={selected.opacity}
                  min={0}
                  max={100}
                  step={1}
                  defaultValue={100}
                  onChange={(v) => updateMask(selected.id, { opacity: v })}
                  onCommit={() => commitEdit("Mask Amount")}
                />

                <MaskScopeProvider maskId={selected.id}>
                  {activeDefs.map((def) => (
                    <MaskSubPanel
                      key={def.id}
                      def={def}
                      onRemove={() => removePanel(def.id)}
                    />
                  ))}
                </MaskScopeProvider>

                {orphanedIds.map((id) => (
                  <div
                    key={id}
                    className="flex items-center justify-between rounded bg-surface-2/40 p-1.5"
                  >
                    <span className="truncate text-[10px] text-text-muted">
                      {id} <span className="opacity-70">(not installed)</span>
                    </span>
                    <button
                      onClick={() => removePanel(id)}
                      title={`Remove ${id}`}
                      className="rounded px-1 text-text-muted hover:text-label-red"
                    >
                      ×
                    </button>
                  </div>
                ))}

                {availablePanels.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-[10px] text-text-muted">Adjust:</span>
                    {availablePanels.map((d) => (
                      <button
                        key={d.id}
                        onClick={() => addPanel(d)}
                        className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-secondary hover:text-text-primary"
                      >
                        + {d.title}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

// Dropdown listing every component kind (geometric + parametric ranges).
function ToolMenu({
  onPick,
  onClose,
}: {
  onPick: (kind: MaskComponentKind) => void;
  onClose: () => void;
}) {
  return (
    <>
      {/* Click-away catcher. */}
      <div className="fixed inset-0 z-10" onClick={onClose} />
      <div className="absolute left-0 right-0 top-full z-20 mt-0.5 space-y-0.5 rounded border border-border-subtle bg-surface-3 p-1 shadow-lg">
        {GEO_TOOLS.map((t) => (
          <button
            key={t.type}
            onClick={() => onPick(t.type)}
            className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-text-secondary hover:bg-surface-2 hover:text-text-primary"
          >
            <span className="w-3 text-center text-text-muted">{KIND_ICON[t.type]}</span>
            {t.label}
          </button>
        ))}
        <div className="my-0.5 border-t border-border-subtle" />
        {RANGE_TOOLS.map((t) => (
          <button
            key={t.kind}
            onClick={() => onPick(t.kind)}
            className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-text-secondary hover:bg-surface-2 hover:text-text-primary"
          >
            <span className="w-3 text-center text-text-muted">{KIND_ICON[t.kind]}</span>
            {t.label}
          </button>
        ))}
      </div>
    </>
  );
}

// A compact numeric geometry field (UV stored 0..1, edited as a percentage). This
// is the always-on, non-drag/keyboard path for radial & linear masks (WCAG 2.1.1
// / 2.5.7) — available regardless of the "Keyboard canvas editing" toggle, which
// only governs the richer on-canvas arrow-key handle nudging.
const uvToPct = (v: number) => Math.round(v * 100);
function GeoField({
  label,
  title,
  value,
  onChange,
  onCommit,
}: {
  label: string;
  title: string;
  value: number;
  onChange: (v: number) => void;
  onCommit: () => void;
}) {
  return (
    <label className="flex items-center gap-1 text-[10px] text-text-muted" title={title}>
      <span className="select-none">{label}</span>
      <input
        type="number"
        value={value}
        aria-label={title}
        onChange={(e) => {
          if (e.target.value !== "") onChange(Number(e.target.value));
        }}
        onBlur={onCommit}
        className="w-11 rounded bg-surface-2 px-1 text-right tabular-nums text-text-primary outline-none focus:bg-surface-3"
      />
    </label>
  );
}

// Geometry / range controls for the selected component.
function ComponentControls({ maskId, comp }: { maskId: string; comp: MaskComponent }) {
  const updateComponent = useDevelopStore((s) => s.updateComponent);
  const commitEdit = useDevelopStore((s) => s.commitEdit);
  const maskColorPicking = useDevelopStore((s) => s.maskColorPicking);
  const setMaskColorPicking = useDevelopStore((s) => s.setMaskColorPicking);
  const setActiveTool = useDevelopStore((s) => s.setActiveTool);
  // Numeric geometry fields are the keyboard/non-drag path — gated like the tone
  // curve's number row, so they only show with "Keyboard canvas editing" on.
  const kbd = useKeyboardCanvasEditing();

  if (comp.kind === "radial" && comp.radial) {
    const r = comp.radial;
    const setR = (patch: Partial<typeof r>) =>
      updateComponent(maskId, comp.id, { radial: { ...r, ...patch } });
    const commitGeo = () => commitEdit("Mask Geometry");
    return (
      <div className="space-y-1 rounded bg-surface-2/40 p-1.5">
        {kbd && (
          <>
            <span className="text-[10px] uppercase tracking-wider text-text-muted">
              Geometry
            </span>
            <div className="flex flex-wrap gap-x-2 gap-y-1">
              <GeoField label="X" title="Centre X (%)" value={uvToPct(r.cx)} onChange={(v) => setR({ cx: v / 100 })} onCommit={commitGeo} />
              <GeoField label="Y" title="Centre Y (%)" value={uvToPct(r.cy)} onChange={(v) => setR({ cy: v / 100 })} onCommit={commitGeo} />
              <GeoField label="W" title="Radius X (%)" value={uvToPct(r.rx)} onChange={(v) => setR({ rx: Math.max(0, v / 100) })} onCommit={commitGeo} />
              <GeoField label="H" title="Radius Y (%)" value={uvToPct(r.ry)} onChange={(v) => setR({ ry: Math.max(0, v / 100) })} onCommit={commitGeo} />
              <GeoField label="∠" title="Angle (degrees)" value={Math.round((r.angle * 180) / Math.PI)} onChange={(v) => setR({ angle: (v * Math.PI) / 180 })} onCommit={commitGeo} />
            </div>
          </>
        )}
        <Slider
          label="Feather"
          value={Math.round(r.feather * 100)}
          min={0}
          max={100}
          step={1}
          defaultValue={50}
          onChange={(v) => setR({ feather: v / 100 })}
          onCommit={() => commitEdit("Mask Feather")}
        />
      </div>
    );
  }

  if (comp.kind === "linear" && comp.linear) {
    // Linear masks have only the numeric geometry here, so the whole section is
    // the keyboard/non-drag path — hidden unless "Keyboard canvas editing" is on.
    if (!kbd) return null;
    const g = comp.linear;
    const setG = (patch: Partial<typeof g>) =>
      updateComponent(maskId, comp.id, { linear: { ...g, ...patch } });
    const commitGeo = () => commitEdit("Mask Geometry");
    return (
      <div className="space-y-1 rounded bg-surface-2/40 p-1.5">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">
          Geometry
        </span>
        <div className="flex flex-wrap gap-x-2 gap-y-1">
          <GeoField label="X1" title="Start X (%)" value={uvToPct(g.x0)} onChange={(v) => setG({ x0: v / 100 })} onCommit={commitGeo} />
          <GeoField label="Y1" title="Start Y (%)" value={uvToPct(g.y0)} onChange={(v) => setG({ y0: v / 100 })} onCommit={commitGeo} />
          <GeoField label="X2" title="End X (%)" value={uvToPct(g.x1)} onChange={(v) => setG({ x1: v / 100 })} onCommit={commitGeo} />
          <GeoField label="Y2" title="End Y (%)" value={uvToPct(g.y1)} onChange={(v) => setG({ y1: v / 100 })} onCommit={commitGeo} />
        </div>
      </div>
    );
  }

  if (comp.kind === "lumRange" && comp.lumRange) {
    const g = comp.lumRange;
    const pct = (v: number) => Math.round(v * 100);
    const set = (patch: Partial<typeof g>) =>
      updateComponent(maskId, comp.id, { lumRange: { ...g, ...patch } });
    return (
      <div className="space-y-0.5 rounded bg-surface-2/40 p-1.5">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">
          Luminance range
        </span>
        <Slider label="Low" value={pct(g.lo)} min={0} max={100} step={1} defaultValue={0}
          onChange={(v) => set({ lo: Math.min(v / 100, g.hi) })}
          onCommit={() => commitEdit("Lum Range")} />
        <Slider label="High" value={pct(g.hi)} min={0} max={100} step={1} defaultValue={100}
          onChange={(v) => set({ hi: Math.max(v / 100, g.lo) })}
          onCommit={() => commitEdit("Lum Range")} />
        <Slider label="Low Falloff" value={pct(g.loFeather)} min={0} max={100} step={1} defaultValue={10}
          onChange={(v) => set({ loFeather: v / 100 })}
          onCommit={() => commitEdit("Lum Range")} />
        <Slider label="High Falloff" value={pct(g.hiFeather)} min={0} max={100} step={1} defaultValue={10}
          onChange={(v) => set({ hiFeather: v / 100 })}
          onCommit={() => commitEdit("Lum Range")} />
      </div>
    );
  }

  if (comp.kind === "colorRange" && comp.colorRange) {
    const g = comp.colorRange;
    const pct = (v: number) => Math.round(v * 100);
    const set = (patch: Partial<typeof g>) =>
      updateComponent(maskId, comp.id, { colorRange: { ...g, ...patch } });
    // Approximate display swatch from the stored linear target.
    const lin2srgb = (v: number) =>
      Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255);
    const swatch = `rgb(${lin2srgb(g.r)}, ${lin2srgb(g.g)}, ${lin2srgb(g.b)})`;
    return (
      <div className="space-y-0.5 rounded bg-surface-2/40 p-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">Color range</span>
          <button
            onClick={() => {
              setActiveTool("mask");
              setMaskColorPicking(!maskColorPicking);
            }}
            title="Pick a target colour from the image"
            className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${
              maskColorPicking
                ? "border-accent text-accent"
                : "border-border-subtle text-text-secondary hover:text-text-primary"
            }`}
          >
            <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: swatch }} />
            Pick
          </button>
        </div>
        <Slider label="Hue Range" value={pct(g.hueRange)} min={0} max={100} step={1} defaultValue={15}
          onChange={(v) => set({ hueRange: v / 100 })}
          onCommit={() => commitEdit("Color Range")} />
        <Slider label="Sat Range" value={pct(g.satRange)} min={0} max={100} step={1} defaultValue={30}
          onChange={(v) => set({ satRange: v / 100 })}
          onCommit={() => commitEdit("Color Range")} />
        <Slider label="Smoothness" value={pct(g.smoothness)} min={0} max={100} step={1} defaultValue={25}
          onChange={(v) => set({ smoothness: v / 100 })}
          onCommit={() => commitEdit("Color Range")} />
      </div>
    );
  }

  return null;
}
