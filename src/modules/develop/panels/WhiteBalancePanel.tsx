// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { AutoButton } from "@/ui/components/AutoButton";
import { PickerIcon } from "@/ui/components/PickerIcon";
import { useDevelopStore } from "@/state/develop-store";
import { useAutoAdjust } from "@/hooks/use-auto-adjust";
import { useMaskScope } from "@/modules/develop/mask-scope";
import type { MaskPanelContribution } from "@/extensions/types";

export function WhiteBalancePanel() {
  const params = useDevelopStore((s) => s.params);
  const setParam = useDevelopStore((s) => s.setParam);
  const commitEdit = useDevelopStore((s) => s.commitEdit);
  const histogram = useDevelopStore((s) => s.histogram);
  const wbPicking = useDevelopStore((s) => s.wbPicking);
  const setWbPicking = useDevelopStore((s) => s.setWbPicking);
  const asShotTemperature = useDevelopStore((s) => s.asShotTemperature);
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
          <PickerIcon />
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
          defaultValue={asShotTemperature}
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

// Per-mask instance: relative warm/cool and magenta/green shifts (-100..100)
// rather than the global panel's absolute Kelvin scale. The picker and Auto
// act on the whole image, so neither appears here.
function WhiteBalanceMaskPanel() {
  const scope = useMaskScope();
  return (
    <div className="space-y-0.5">
      <Slider
        label="Temp"
        value={scope.adj.temperature}
        min={-100}
        max={100}
        step={1}
        defaultValue={0}
        onChange={(v) => scope.setAdj({ temperature: v })}
        onCommit={() => scope.commit("Mask Temp")}
      />
      <Slider
        label="Tint"
        value={scope.adj.tint}
        min={-100}
        max={100}
        step={1}
        defaultValue={0}
        onChange={(v) => scope.setAdj({ tint: v })}
        onCommit={() => scope.commit("Mask Tint")}
      />
    </div>
  );
}

export const WHITE_BALANCE_MASK_PANEL: MaskPanelContribution = {
  component: WhiteBalanceMaskPanel,
  order: 20,
  owns: ["temperature", "tint"],
};
