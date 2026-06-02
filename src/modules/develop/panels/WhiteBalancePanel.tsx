import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { useDevelopStore } from "@/state/develop-store";

export function WhiteBalancePanel() {
  const params = useDevelopStore((s) => s.params);
  const setParam = useDevelopStore((s) => s.setParam);
  const commitEdit = useDevelopStore((s) => s.commitEdit);

  return (
    <Panel title="White Balance">
      <div className="space-y-0.5">
        <Slider
          label="Temp"
          value={params.temperature}
          min={2000}
          max={50000}
          step={10}
          defaultValue={6500}
          onChange={(v) => setParam("temperature", v)}
          onCommit={() => commitEdit("Temperature")}
        />
        <Slider
          label="Tint"
          value={params.tint}
          min={-150}
          max={150}
          defaultValue={0}
          onChange={(v) => setParam("tint", v)}
          onCommit={() => commitEdit("Tint")}
        />
      </div>
    </Panel>
  );
}
