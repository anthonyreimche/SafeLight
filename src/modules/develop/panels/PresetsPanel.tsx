import { useEffect, useMemo, useState } from "react";
import { Panel } from "@/ui/components/Panel";
import { useDevelopStore } from "@/state/develop-store";
import { usePresetsStore, nextAvailableName, type Preset } from "@/state/presets-store";
import { usePresetImporters } from "@/extensions/registry";
import { normalizeParams, type DevelopParams } from "@/catalog/types";
import { exportPreset, pickPresetFile, parseSafelightPreset } from "../preset-io";
import { summarizePreset } from "../preset-summary";
import { PresetTooltip } from "./PresetTooltip";
import { PresetOverwriteDialog } from "./PresetOverwriteDialog";
import { PresetSaveDialog } from "./PresetSaveDialog";

interface PendingSave {
  name: string;
  group: string;
  params: Partial<DevelopParams>;
}

export function PresetsPanel() {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [collision, setCollision] = useState<{ existingId: string; pending: PendingSave } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const params = useDevelopStore((s) => s.params);
  const applyPreset = useDevelopStore((s) => s.applyPreset);
  const setPreviewParams = useDevelopStore((s) => s.setPreviewParams);
  const presets = usePresetsStore((s) => s.presets);
  const addPreset = usePresetsStore((s) => s.add);
  const updatePreset = usePresetsStore((s) => s.update);
  const removePreset = usePresetsStore((s) => s.remove);
  const importers = usePresetImporters();

  // Safety net: clear any lingering preview if the panel unmounts mid-hover.
  useEffect(() => () => setPreviewParams(null), [setPreviewParams]);

  // A preset carries only some adjustments; applying merges them over the
  // photo's current params (partial presets), so unselected settings are kept.
  const effective = (partial: Partial<DevelopParams>): DevelopParams =>
    normalizeParams({ ...params, ...partial });

  const groups = useMemo(() => {
    const names = new Set<string>();
    for (const p of presets) if (p.group) names.add(p.group);
    return [...names];
  }, [presets]);

  // Ungrouped first, then each named group (insertion order), each keeping the
  // presets' stored order.
  const sections = useMemo(() => {
    const ungrouped = presets.filter((p) => !p.group);
    const named = groups.map((g) => ({
      group: g,
      items: presets.filter((p) => p.group === g),
    }));
    return { ungrouped, named };
  }, [presets, groups]);

  const commitSave = (pending: PendingSave) => {
    const existing = presets.find(
      (p) => p.name.toLowerCase() === pending.name.toLowerCase(),
    );
    if (existing) {
      setCollision({ existingId: existing.id, pending });
      return;
    }
    addPreset(pending.name, pending.params, pending.group);
  };

  const handleImport = async () => {
    const accept = [".json", ...importers.flatMap((i) => i.extensions)].join(",");
    const file = await pickPresetFile(accept);
    if (!file) return;

    // SafeLight's own JSON first, then any registered importer by extension.
    const native = await parseSafelightPreset(file);
    if (native) {
      addPreset(native.name, native.params, native.group);
      applyPreset(effective(native.params));
      return;
    }
    const lower = file.name.toLowerCase();
    const importer = importers.find((i) => i.extensions.some((e) => lower.endsWith(e)));
    if (!importer) return;
    const result = await importer.parse(file);
    if (!result) return;
    addPreset(result.name, result.params);
    applyPreset(effective(result.params));
  };

  const renderPreset = (preset: Preset) => (
    <div
      key={preset.id}
      className="group relative flex items-center justify-between rounded px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-2"
      onMouseEnter={() => {
        setHoveredId(preset.id);
        setPreviewParams(effective(preset.params));
      }}
      onMouseLeave={() => {
        setHoveredId((id) => (id === preset.id ? null : id));
        setPreviewParams(null);
      }}
    >
      <button
        onClick={() => {
          setPreviewParams(null);
          applyPreset(effective(preset.params));
        }}
        className="min-w-0 flex-1 truncate text-left hover:text-text-primary"
      >
        {preset.name}
      </button>
      <button
        onClick={() => removePreset(preset.id)}
        className="ml-1 text-text-muted opacity-0 hover:text-label-red group-hover:opacity-100"
        title="Delete preset"
      >
        ✕
      </button>
      {hoveredId === preset.id && (
        <PresetTooltip name={preset.name} diffs={summarizePreset(preset.params)} />
      )}
    </div>
  );

  return (
    <Panel title="Presets" defaultOpen={false}>
      <div className="mb-2 flex gap-1">
        <button
          onClick={() => setSaving(true)}
          className="flex-1 rounded bg-surface-3 px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-4 hover:text-text-primary"
        >
          Save preset…
        </button>
        <button
          onClick={handleImport}
          className="flex-1 rounded bg-surface-2 px-2 py-1 text-[10px] text-text-secondary hover:bg-surface-3 hover:text-text-primary"
        >
          Import
        </button>
        <button
          onClick={() => exportPreset("preset", params)}
          className="flex-1 rounded bg-surface-2 px-2 py-1 text-[10px] text-text-secondary hover:bg-surface-3 hover:text-text-primary"
        >
          Export
        </button>
      </div>

      {presets.length === 0 ? (
        <p className="text-[10px] text-text-muted">No saved presets</p>
      ) : (
        <div className="space-y-1">
          {sections.ungrouped.length > 0 && (
            <div className="space-y-0.5">{sections.ungrouped.map(renderPreset)}</div>
          )}
          {sections.named.map(({ group, items }) => {
            const isCollapsed = collapsed.has(group);
            return (
              <div key={group}>
                <button
                  onClick={() =>
                    setCollapsed((s) => {
                      const next = new Set(s);
                      if (next.has(group)) next.delete(group);
                      else next.add(group);
                      return next;
                    })
                  }
                  className="flex w-full items-center gap-1 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted hover:text-text-secondary"
                >
                  <span className="inline-block w-3">{isCollapsed ? "▸" : "▾"}</span>
                  <span className="truncate">{group}</span>
                  <span className="ml-auto tabular-nums opacity-60">{items.length}</span>
                </button>
                {!isCollapsed && <div className="space-y-0.5">{items.map(renderPreset)}</div>}
              </div>
            );
          })}
        </div>
      )}

      {saving && (
        <PresetSaveDialog
          params={params}
          groups={groups}
          onSave={(result) => {
            setSaving(false);
            commitSave(result);
          }}
          onCancel={() => setSaving(false)}
        />
      )}

      {collision && (
        <PresetOverwriteDialog
          name={collision.pending.name}
          onOverwrite={() => {
            updatePreset(collision.existingId, collision.pending.params, collision.pending.group);
            setCollision(null);
          }}
          onSaveAsNew={() => {
            addPreset(
              nextAvailableName(presets, collision.pending.name),
              collision.pending.params,
              collision.pending.group,
            );
            setCollision(null);
          }}
          onCancel={() => setCollision(null)}
        />
      )}
    </Panel>
  );
}
