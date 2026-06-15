import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { useDevelopStore } from "@/state/develop-store";
import type { LensCorrectionParams } from "@/catalog/types";

interface SliderDef {
  key: keyof LensCorrectionParams;
  label: string;
  min: number;
  max: number;
  step: number;
}

const SLIDERS: SliderDef[] = [
  { key: "distortion",          label: "Distortion",  min: -100, max: 100, step: 1 },
  { key: "chromaticAberration", label: "Fringing",    min: 0,    max: 100, step: 1 },
  { key: "defringe",            label: "Defringe",    min: 0,    max: 100, step: 1 },
  { key: "vignetting",          label: "Vignetting",  min: -100, max: 100, step: 1 },
];

export function LensCorrectionPanel() {
  const lensCorrection = useDevelopStore((s) => s.params.lensCorrection);
  const setParam = useDevelopStore((s) => s.setParam);
  const commitEdit = useDevelopStore((s) => s.commitEdit);

  return (
    <Panel title="Lens Correction" defaultOpen={false}>
      <div className="space-y-0.5">
        {SLIDERS.map((s) => (
          <Slider
            key={s.key}
            label={s.label}
            value={lensCorrection[s.key]}
            min={s.min}
            max={s.max}
            step={s.step}
            onChange={(v) =>
              setParam("lensCorrection", { ...lensCorrection, [s.key]: v })
            }
            onCommit={() => commitEdit(`Lens ${s.label}`)}
          />
        ))}
      </div>
    </Panel>
  );
}
