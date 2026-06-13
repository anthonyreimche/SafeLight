import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { AutoButton } from "@/ui/components/AutoButton";
import { useDevelopStore } from "@/state/develop-store";
import { useAutoAdjust } from "@/hooks/use-auto-adjust";

export function WhiteBalancePanel() {
  const params = useDevelopStore((s) => s.params);
  const setParam = useDevelopStore((s) => s.setParam);
  const commitEdit = useDevelopStore((s) => s.commitEdit);
  const histogram = useDevelopStore((s) => s.histogram);
  const wbPicking = useDevelopStore((s) => s.wbPicking);
  const setWbPicking = useDevelopStore((s) => s.setWbPicking);
  const { autoWhiteBalance } = useAutoAdjust();

  return (
    <Panel title="White Balance">
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          onClick={() => setWbPicking(!wbPicking)}
          disabled={!histogram}
          title="White balance selector — click a neutral grey in the image"
          aria-pressed={wbPicking}
          className={`flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider disabled:cursor-default disabled:opacity-40 ${
            wbPicking
              ? "border-accent bg-accent/30 text-text-primary"
              : "border-border-subtle text-text-secondary hover:border-border hover:text-text-primary"
          }`}
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m2 22 1-1h3l9-9" />
            <path d="M3 21v-3l9-9" />
            <path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z" />
          </svg>
          Picker
        </button>
        <AutoButton
          onClick={autoWhiteBalance}
          disabled={!histogram}
          title="Auto white balance (gray-world)"
        />
      </div>
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
