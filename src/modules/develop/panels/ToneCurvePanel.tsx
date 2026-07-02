// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { Panel } from "@/ui/components/Panel";
import { CurveEditor } from "@/ui/components/CurveEditor";
import { useDevelopStore } from "@/state/develop-store";
import { useMaskScope } from "@/modules/develop/mask-scope";
import { defaultToneCurves } from "@/catalog/types";
import type { MaskPanelContribution } from "@/extensions/types";

export function ToneCurvePanel() {
  return (
    <Panel title="Tone Curve">
      <GlobalCurveEditor />
    </Panel>
  );
}

// Separate component so the editor mounts/unmounts with the Panel's open
// state — guaranteeing the canvas is (re)drawn every time it reopens.
function GlobalCurveEditor() {
  const curves = useDevelopStore((s) => s.params.toneCurve);
  const setToneCurve = useDevelopStore((s) => s.setToneCurve);
  const commitEdit = useDevelopStore((s) => s.commitEdit);

  return (
    <CurveEditor
      curves={curves}
      onChange={setToneCurve}
      onCommit={() => commitEdit("Tone Curve")}
    />
  );
}

// Per-mask instance. The mask's curve starts from the already-developed color
// (no Adobe base curve — see buildMaskCurveLUT); absent until first edit
// because the block is seeded when the sub-panel is added.
function ToneCurveMaskPanel() {
  const scope = useMaskScope();
  const curves = scope.toneCurve ?? defaultToneCurves();
  return (
    <CurveEditor
      compact
      curves={curves}
      onChange={(channel, points) => scope.setToneCurve({ ...curves, [channel]: points })}
      onCommit={() => scope.commit("Mask Tone Curve")}
    />
  );
}

export const TONE_CURVE_MASK_PANEL: MaskPanelContribution = {
  component: ToneCurveMaskPanel,
  order: 30,
  owns: ["toneCurve"],
};
