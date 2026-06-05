import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { useDevelopStore } from "@/state/develop-store";
import { MAX_RETOUCH } from "@/catalog/types";

export function RetouchPanel() {
  const activeTool = useDevelopStore((s) => s.activeTool);
  const retouchMode = useDevelopStore((s) => s.retouchMode);
  const retouchSize = useDevelopStore((s) => s.retouchSize);
  const retouchFeather = useDevelopStore((s) => s.retouchFeather);
  const retouchOpacity = useDevelopStore((s) => s.retouchOpacity);
  const spots = useDevelopStore((s) => s.params.retouch);
  const selectedSpotId = useDevelopStore((s) => s.selectedSpotId);

  const setActiveTool = useDevelopStore((s) => s.setActiveTool);
  const setRetouchMode = useDevelopStore((s) => s.setRetouchMode);
  const setRetouchSize = useDevelopStore((s) => s.setRetouchSize);
  const setRetouchFeather = useDevelopStore((s) => s.setRetouchFeather);
  const setRetouchOpacity = useDevelopStore((s) => s.setRetouchOpacity);
  const selectSpot = useDevelopStore((s) => s.selectSpot);
  const removeSpot = useDevelopStore((s) => s.removeSpot);
  const updateSpot = useDevelopStore((s) => s.updateSpot);
  const commitEdit = useDevelopStore((s) => s.commitEdit);

  const active = activeTool === "retouch";
  // When a spot is selected its properties drive the sliders so they edit it in
  // place; otherwise the sliders set the defaults for the next spot you create.
  const selected = spots.find((s) => s.id === selectedSpotId) ?? null;

  const pick = (mode: "heal" | "clone") => {
    setRetouchMode(mode);
    setActiveTool("retouch");
    // Clicking a mode while a spot is selected retargets that spot too.
    if (selected && selected.mode !== mode) {
      updateSpot(selected.id, { mode });
      commitEdit("Spot Mode");
    }
  };

  // Slider value sources: selected spot when present, else the tool default.
  const sizeVal = Math.round((selected ? selected.radius : retouchSize) * 100);
  const featherVal = selected ? selected.feather : retouchFeather;
  const opacityVal = selected ? selected.opacity : retouchOpacity;
  const activeMode = selected ? selected.mode : retouchMode;

  const onSize = (v: number) =>
    selected ? updateSpot(selected.id, { radius: v / 100 }) : setRetouchSize(v / 100);
  const onFeather = (v: number) =>
    selected ? updateSpot(selected.id, { feather: v }) : setRetouchFeather(v);
  const onOpacity = (v: number) =>
    selected ? updateSpot(selected.id, { opacity: v }) : setRetouchOpacity(v);
  const commitIf = (label: string) => () => {
    if (selected) commitEdit(label);
  };

  return (
    <Panel title="Heal / Clone" defaultOpen>
      <div className="space-y-2">
        <div className="flex gap-1">
          {(["heal", "clone"] as const).map((m) => (
            <button
              key={m}
              onClick={() => pick(m)}
              className={`flex-1 rounded px-1.5 py-1 text-[11px] capitalize ${
                (active || selected) && activeMode === m
                  ? "bg-accent/30 text-text-primary"
                  : "bg-surface-2 text-text-secondary hover:text-text-primary"
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between">
          <span className="text-[10px] text-text-muted">
            {active
              ? "Click or drag to remove · drag the source ring to resample"
              : `${spots.length}/${MAX_RETOUCH} spots`}
          </span>
          {active && (
            <button
              onClick={() => setActiveTool("none")}
              className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-text-secondary hover:text-text-primary"
            >
              Done
            </button>
          )}
        </div>

        <div className="space-y-0.5 rounded bg-surface-2/50 p-1.5">
          <div className="pb-0.5 text-[10px] uppercase tracking-wider text-text-muted">
            {selected ? `Editing ${selected.mode} spot` : "New spot defaults"}
          </div>
          <Slider
            label="Size"
            value={sizeVal}
            min={1}
            max={30}
            step={1}
            defaultValue={4}
            onChange={onSize}
            onCommit={commitIf("Spot Size")}
          />
          <Slider
            label="Feather"
            value={featherVal}
            min={0}
            max={100}
            step={1}
            defaultValue={50}
            onChange={onFeather}
            onCommit={commitIf("Spot Feather")}
          />
          <Slider
            label="Opacity"
            value={opacityVal}
            min={0}
            max={100}
            step={1}
            defaultValue={100}
            onChange={onOpacity}
            onCommit={commitIf("Spot Opacity")}
          />
        </div>

        {spots.length > 0 && (
          <div className="space-y-0.5">
            {spots.map((s, i) => (
              <div
                key={s.id}
                onClick={() => {
                  // Open the spot for editing: select it and activate the tool so
                  // its source/destination handles appear on the image.
                  selectSpot(s.id);
                  setRetouchMode(s.mode);
                  setActiveTool("retouch");
                }}
                className={`flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[11px] ${
                  s.id === selectedSpotId
                    ? "bg-accent/20 text-text-primary"
                    : "text-text-secondary hover:bg-surface-2"
                }`}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: s.mode === "clone" ? "#ffd24a" : "#4affa3" }}
                />
                <span className="flex-1 truncate capitalize">
                  {s.mode} {i + 1}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    updateSpot(s.id, { mode: s.mode === "heal" ? "clone" : "heal" });
                    commitEdit("Spot Mode");
                  }}
                  title="Toggle heal/clone"
                  className="rounded px-1 text-text-muted hover:text-text-primary"
                >
                  ⇄
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeSpot(s.id);
                    commitEdit("Delete Spot");
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
      </div>
    </Panel>
  );
}
