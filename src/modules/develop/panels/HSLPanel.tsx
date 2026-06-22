// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

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
    <Panel title="HSL">
      <div className="mb-2 flex items-center">
        <button
          type="button"
          onClick={() => setHslPicking(!hslPicking)}
          aria-pressed={hslPicking}
          className={`flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider ${
            hslPicking
              ? "border-accent bg-accent/30 text-text-primary"
              : "border-border-subtle text-text-secondary hover:border-border hover:text-text-primary"
          }`}
          title={`Drag up/down on image to adjust ${selectedBand}`}
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
