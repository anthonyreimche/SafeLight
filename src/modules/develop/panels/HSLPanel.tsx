import { Panel } from "@/ui/components/Panel";
import { HSLMixer } from "@/ui/components/HSLMixer";
import { useDevelopStore } from "@/state/develop-store";
import { useEffect } from "react";

export function HSLPanel() {
  const hsl = useDevelopStore((s) => s.params.hsl);
  const setHslValue = useDevelopStore((s) => s.setHslValue);
  const commitEdit = useDevelopStore((s) => s.commitEdit);
  const hslPicking = useDevelopStore((s) => s.hslPicking);
  const setHslPicking = useDevelopStore((s) => s.setHslPicking);
  const selectedBand = useDevelopStore((s) => s.selectedHslBand);
  const setSelectedBand = useDevelopStore((s) => s.setSelectedHslBand);

  // Exit picking mode on Escape key
  useEffect(() => {
    if (!hslPicking) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setHslPicking(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hslPicking, setHslPicking]);

  return (
    <Panel title="HSL / Color">
      {/* Picker button at top like Auto buttons */}
      <div className="mb-2 flex justify-end">
        <button
          type="button"
          onClick={() => setHslPicking(!hslPicking)}
          className={`rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors ${
            hslPicking
              ? "border-accent bg-accent text-white"
              : "border-border-subtle text-text-secondary hover:text-text-primary hover:border-border"
          }`}
          title={`Drag up/down on image to adjust ${selectedBand}`}
        >
          {hslPicking ? "Picking..." : "Picker"}
        </button>
      </div>

      <HSLMixer
        value={hsl}
        onChange={setHslValue}
        onCommit={(channel) => commitEdit(`HSL ${channel}`)}
        selectedBand={selectedBand}
        onBandChange={setSelectedBand}
      />
    </Panel>
  );
}
