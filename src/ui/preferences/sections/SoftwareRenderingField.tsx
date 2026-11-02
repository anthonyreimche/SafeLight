// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useEffect, useState } from "react";
import { privilegedGpu } from "@/native/privileged";
import type { NativeGpuBackendState } from "@/extensions/types";
import { ToggleField } from "@/ui/preferences/fields";

// The Rendering section lists it for search when the module loads.
export const SOFTWARE_RENDERING = "Software rendering";

const SOFTWARE_REASON: Record<"webgl2-unavailable" | "gpu-crashes", string> = {
  "webgl2-unavailable": "Safelight turned this on because the graphics card couldn't run WebGL2.",
  "gpu-crashes": "Safelight turned this on because the graphics driver kept crashing.",
};

// The graphics backend is picked before the window exists, from a probe
// Safelight keeps in its config folder; the field shows once the bridge
// reports which one this launch uses.
function softwareRenderingSupported(): boolean {
  return privilegedGpu() !== null;
}

// The search index is built as this module loads, before boot claims the
// privileged bridge, so it only asks whether there is one to claim.
export function softwareRenderingListed(): boolean {
  return window.safelightNative?.claimPrivileged !== undefined;
}

// Safelight moves to software rendering by itself when the graphics card
// can't run WebGL2 or its driver keeps crashing, which a virtual machine often
// does; this says so and is the way back.
export function SoftwareRenderingField() {
  const supported = softwareRenderingSupported();
  const [state, setState] = useState<NativeGpuBackendState | null>(null);

  useEffect(() => {
    if (!supported) return;
    let live = true;
    void privilegedGpu()
      ?.backend()
      .then((s) => {
        if (live) setState(s);
      });
    return () => {
      live = false;
    };
  }, [supported]);

  if (!supported || !state) return null;

  const change = (on: boolean) => {
    void privilegedGpu()
      ?.setSoftware(on)
      .then((s) => {
        if (s) setState(s);
      });
  };
  const why =
    state.reason === "webgl2-unavailable" || state.reason === "gpu-crashes"
      ? SOFTWARE_REASON[state.reason]
      : null;

  return (
    <div>
      <ToggleField
        label={SOFTWARE_RENDERING}
        hint="Draws on the processor instead of the graphics card: slower, but it works in virtual machines and with graphics drivers that can't run WebGL2. Safelight turns this on by itself when the graphics card fails; turn it off to try the graphics card again."
        checked={state.nextSoftware}
        onChange={change}
      />
      {why && <p className="mt-1 text-[10px] leading-relaxed text-text-secondary">{why}</p>}
      {state.nextSoftware !== state.software && (
        <p className="mt-1 text-[10px] leading-relaxed text-text-secondary">
          Takes effect when you restart Safelight.
        </p>
      )}
    </div>
  );
}
