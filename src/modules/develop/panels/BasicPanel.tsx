// Safelight â€” founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 Â§7b) â€” see LICENSE. This notice must
// be preserved in derived versions.

import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { AutoButton } from "@/ui/components/AutoButton";
import { useDevelopStore } from "@/state/develop-store";
import { useSettings } from "@/state/settings-store";
import { useAutoAdjust } from "@/hooks/use-auto-adjust";
import { useMaskScope } from "@/modules/develop/mask-scope";
import type { MaskAdjustments } from "@/catalog/types";
import type { MaskPanelContribution } from "@/extensions/types";
import { TONAL_PARAM_RANGE, type NumericParamKey } from "./tonal-params";

// Per-band detail sliders are opt-in (Preferences â–¸ Interface) to keep the panel
// compact. Tone recovery/lift preserves micro-contrast on its own regardless;
// these only expose manual control over it.
const DETAIL_KEYS = new Set<NumericParamKey>(["highlightDetail", "shadowDetail"]);

// Ranges come from TONAL_PARAM_RANGE — one source shared with the histogram's
// draggable zones so the limits can't drift.
const basicSliders: {
  key: keyof typeof TONAL_PARAM_RANGE & NumericParamKey;
  label: string;
  // Slider-icon contribution id; defaults to `core.${key}`. The per-band detail
  // sliders borrow their parent band's icon so they read as a sub-control.
  icon?: string;
}[] = [
  { key: "exposure", label: "Exposure" },
  { key: "contrast", label: "Contrast" },
  { key: "highlights", label: "Highlights" },
  { key: "highlightDetail", label: "Highlight Detail", icon: "core.highlights" },
  { key: "shadows", label: "Shadows" },
  { key: "shadowDetail", label: "Shadow Detail", icon: "core.shadows" },
  { key: "whites", label: "Whites" },
  { key: "blacks", label: "Blacks" },
  { key: "texture", label: "Texture" },
  { key: "clarity", label: "Clarity" },
  { key: "dehaze", label: "Dehaze" },
  { key: "vibrance", label: "Vibrance" },
  { key: "saturation", label: "Saturation" },
];

export function BasicPanel() {
  const params = useDevelopStore((s) => s.params);
  const setParam = useDevelopStore((s) => s.setParam);
  const commitEdit = useDevelopStore((s) => s.commitEdit);
  const histogram = useDevelopStore((s) => s.histogram);
  const showDetail = useSettings((s) => s.basicDetailSliders);
  const { autoTone } = useAutoAdjust();

  const sliders = showDetail
    ? basicSliders
    : basicSliders.filter((s) => !DETAIL_KEYS.has(s.key));

  return (
    <Panel title="Basic">
      <AutoButton onClick={autoTone} disabled={!histogram} title="Auto tone" />
      <div className="space-y-0.5">
        {sliders.map((s) => (
          <Slider
            key={s.key}
            icon={s.icon ?? `core.${s.key}`}
            label={s.label}
            value={params[s.key]}
            min={TONAL_PARAM_RANGE[s.key].min}
            max={TONAL_PARAM_RANGE[s.key].max}
            step={s.key === "exposure" ? 0.1 : 1}
            onChange={(v) => setParam(s.key, v)}
            onCommit={() => commitEdit(s.label)}
          />
        ))}
      </div>
    </Panel>
  );
}

// Per-mask instance: the same tone controls as relative strengths on the
// shader's local-adjustment scale (all -100..100, unlike global exposure's EV
// units), minus the tone-recovery detail sub-sliders, which have no local
// equivalent. Texture/clarity/dehaze apply locally through the Detail
// sub-panel instead â€” see DetailPanel.
const MASK_SLIDERS: { key: keyof MaskAdjustments; label: string }[] = [
  { key: "exposure", label: "Exposure" },
  { key: "contrast", label: "Contrast" },
  { key: "highlights", label: "Highlights" },
  { key: "shadows", label: "Shadows" },
  { key: "whites", label: "Whites" },
  { key: "blacks", label: "Blacks" },
  { key: "saturation", label: "Saturation" },
  { key: "vibrance", label: "Vibrance" },
];

function BasicMaskPanel() {
  const scope = useMaskScope();
  return (
    <div className="space-y-0.5">
      {MASK_SLIDERS.map((s) => (
        <Slider
          key={s.key}
          label={s.label}
          value={scope.adj[s.key]}
          min={-100}
          max={100}
          step={1}
          defaultValue={0}
          onChange={(v) => scope.setAdj({ [s.key]: v })}
          onCommit={() => scope.commit(`Mask ${s.label}`)}
        />
      ))}
    </div>
  );
}

export const BASIC_MASK_PANEL: MaskPanelContribution = {
  component: BasicMaskPanel,
  order: 10,
  owns: MASK_SLIDERS.map((s) => s.key),
};
