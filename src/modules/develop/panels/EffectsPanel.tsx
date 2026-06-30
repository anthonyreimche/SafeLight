// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { useDevelopStore } from "@/state/develop-store";
import type { VignetteParams, GrainParams } from "@/catalog/types";
import { VIGNETTE_ADJUSTMENTS, GRAIN_ADJUSTMENTS } from "@/state/develop-adjustments";

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="px-2 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-widest text-neutral-500">
      {title}
    </div>
  );
}

export function EffectsPanel() {
  const vignette = useDevelopStore((s) => s.params.vignette);
  const grain = useDevelopStore((s) => s.params.grain);
  const setParam = useDevelopStore((s) => s.setParam);
  const commitEdit = useDevelopStore((s) => s.commitEdit);

  return (
    <Panel title="Effects" defaultOpen={false}>
      <div className="space-y-1">
        <div>
          <SectionHeader title="Vignette" />
          <div className="space-y-0.5">
            {VIGNETTE_ADJUSTMENTS.map((s) => {
              const k = s.field as keyof VignetteParams;
              return (
                <Slider
                  key={k}
                  label={s.label}
                  value={vignette[k]}
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  onChange={(v) => setParam("vignette", { ...vignette, [k]: v })}
                  onCommit={() => commitEdit(`Vignette ${s.label}`)}
                />
              );
            })}
          </div>
        </div>
        <div>
          <SectionHeader title="Grain" />
          <div className="space-y-0.5">
            {GRAIN_ADJUSTMENTS.map((s) => {
              const k = s.field as keyof GrainParams;
              return (
                <Slider
                  key={k}
                  label={s.label}
                  value={grain[k]}
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  onChange={(v) => setParam("grain", { ...grain, [k]: v })}
                  onCommit={() => commitEdit(`Grain ${s.label}`)}
                />
              );
            })}
          </div>
        </div>
      </div>
    </Panel>
  );
}
