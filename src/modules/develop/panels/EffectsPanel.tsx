import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { useDevelopStore } from "@/state/develop-store";
import type { VignetteParams, GrainParams } from "@/catalog/types";

interface VigSlider { key: keyof VignetteParams; label: string; min: number; max: number; step: number }
interface GrainSlider { key: keyof GrainParams; label: string; min: number; max: number; step: number }

const VIG_SLIDERS: VigSlider[] = [
  { key: "amount",     label: "Amount",     min: -100, max: 100, step: 1 },
  { key: "midpoint",   label: "Midpoint",   min: 0,    max: 100, step: 1 },
  { key: "roundness",  label: "Roundness",  min: -100, max: 100, step: 1 },
  { key: "feather",    label: "Feather",    min: 0,    max: 100, step: 1 },
  { key: "highlights", label: "Highlights", min: 0,    max: 100, step: 1 },
];

const GRAIN_SLIDERS: GrainSlider[] = [
  { key: "amount",    label: "Amount",    min: 0,  max: 100, step: 1 },
  { key: "size",      label: "Size",      min: 25, max: 100, step: 1 },
  { key: "roughness", label: "Roughness", min: 0,  max: 100, step: 1 },
];

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
            {VIG_SLIDERS.map((s) => (
              <Slider
                key={s.key}
                label={s.label}
                value={vignette[s.key]}
                min={s.min}
                max={s.max}
                step={s.step}
                onChange={(v) => setParam("vignette", { ...vignette, [s.key]: v })}
                onCommit={() => commitEdit(`Vignette ${s.label}`)}
              />
            ))}
          </div>
        </div>
        <div>
          <SectionHeader title="Grain" />
          <div className="space-y-0.5">
            {GRAIN_SLIDERS.map((s) => (
              <Slider
                key={s.key}
                label={s.label}
                value={grain[s.key]}
                min={s.min}
                max={s.max}
                step={s.step}
                onChange={(v) => setParam("grain", { ...grain, [s.key]: v })}
                onCommit={() => commitEdit(`Grain ${s.label}`)}
              />
            ))}
          </div>
        </div>
      </div>
    </Panel>
  );
}
