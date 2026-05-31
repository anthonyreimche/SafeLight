import { useState } from "react";
import { Panel } from "@/ui/components/Panel";
import { useDevelopStore } from "@/state/develop-store";
import { usePresetsStore } from "@/state/presets-store";
import { exportPreset, importPreset } from "../preset-io";

export function PresetsPanel() {
  const [name, setName] = useState("");
  const params = useDevelopStore((s) => s.params);
  const applyPreset = useDevelopStore((s) => s.applyPreset);
  const presets = usePresetsStore((s) => s.presets);
  const addPreset = usePresetsStore((s) => s.add);
  const removePreset = usePresetsStore((s) => s.remove);

  const handleSave = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    addPreset(trimmed, params);
    setName("");
  };

  const handleImport = async () => {
    const imported = await importPreset();
    if (!imported) return;
    addPreset(imported.name, imported.params);
    applyPreset(imported.params);
  };

  return (
    <Panel title="Presets" defaultOpen={false}>
      <div className="mb-2 flex gap-1">
        <input
          type="text"
          value={name}
          placeholder="Preset name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSave()}
          className="min-w-0 flex-1 rounded bg-surface-2 px-2 py-1 text-[11px] text-text-primary placeholder:text-text-muted focus:outline-none"
        />
        <button
          onClick={handleSave}
          className="rounded bg-surface-3 px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-4 hover:text-text-primary"
        >
          Save
        </button>
      </div>

      <div className="mb-2 flex gap-1">
        <button
          onClick={handleImport}
          className="flex-1 rounded bg-surface-2 px-2 py-1 text-[10px] text-text-secondary hover:bg-surface-3 hover:text-text-primary"
        >
          Import JSON
        </button>
        <button
          onClick={() => exportPreset(name.trim() || "preset", params)}
          className="flex-1 rounded bg-surface-2 px-2 py-1 text-[10px] text-text-secondary hover:bg-surface-3 hover:text-text-primary"
        >
          Export JSON
        </button>
      </div>

      {presets.length === 0 ? (
        <p className="text-[10px] text-text-muted">No saved presets</p>
      ) : (
        <div className="space-y-0.5">
          {presets.map((preset) => (
            <div
              key={preset.id}
              className="group flex items-center justify-between rounded px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-2"
            >
              <button
                onClick={() => applyPreset(preset.params)}
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
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
