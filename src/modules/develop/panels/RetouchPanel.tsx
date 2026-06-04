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
  const pick = (mode: "heal" | "clone") => {
    setRetouchMode(mode);
    setActiveTool("retouch");
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
                active && retouchMode === m
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
            {active ? "Click a spot to remove it" : `${spots.length}/${MAX_RETOUCH} spots`}
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
          <Slider
            label="Size"
            value={Math.round(retouchSize * 100)}
            min={1}
            max={30}
            step={1}
            defaultValue={4}
            onChange={(v) => setRetouchSize(v / 100)}
          />
          <Slider
            label="Feather"
            value={retouchFeather}
            min={0}
            max={100}
            step={1}
            defaultValue={50}
            onChange={setRetouchFeather}
          />
          <Slider
            label="Opacity"
            value={retouchOpacity}
            min={0}
            max={100}
            step={1}
            defaultValue={100}
            onChange={setRetouchOpacity}
          />
        </div>

        {spots.length > 0 && (
          <div className="space-y-0.5">
            {spots.map((s, i) => (
              <div
                key={s.id}
                onClick={() => selectSpot(s.id)}
                className={`flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[11px] ${
                  s.id === selectedSpotId
                    ? "bg-accent/20 text-text-primary"
                    : "text-text-secondary hover:bg-surface-2"
                }`}
              >
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
