import { Panel } from "@/ui/components/Panel";
import { CurveEditor } from "@/ui/components/CurveEditor";
import { useDevelopStore } from "@/state/develop-store";

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
