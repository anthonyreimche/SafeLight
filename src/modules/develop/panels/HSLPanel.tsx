import { Panel } from "@/ui/components/Panel";
import { HSLMixer } from "@/ui/components/HSLMixer";
import { useDevelopStore } from "@/state/develop-store";

export function HSLPanel() {
  const hsl = useDevelopStore((s) => s.params.hsl);
  const setHslValue = useDevelopStore((s) => s.setHslValue);
  const commitEdit = useDevelopStore((s) => s.commitEdit);

  return (
    <Panel title="HSL / Color">
      <HSLMixer
        value={hsl}
        onChange={setHslValue}
        onCommit={(channel) => commitEdit(`HSL ${channel}`)}
      />
    </Panel>
  );
}
