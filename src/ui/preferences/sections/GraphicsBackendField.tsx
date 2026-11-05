// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useEffect, useState } from "react";
import { privilegedGpu } from "@/native/privileged";
import type { NativeGpuBackendState } from "@/extensions/types";
import { chooseGraphicsBackend, readGraphicsBackend } from "@/state/graphics-store";
import { Select } from "@/ui/components/Select";
import { Field } from "@/ui/preferences/fields";

// The Rendering section lists it for search when the module loads.
export const GRAPHICS_BACKEND = "Graphics backend";

const AUTOMATIC = "auto";

const BACKEND_LABEL: Record<string, string> = {
  gl: "OpenGL",
  gles: "OpenGL ES",
  vulkan: "Vulkan",
  d3d11: "Direct3D 11",
  metal: "Metal",
  swiftshader: "Software (processor)",
};

const backendLabel = (backend: string): string => BACKEND_LABEL[backend] ?? backend;

const SOFTWARE_REASON: Record<Exclude<NativeGpuBackendState["reason"], "chosen" | null>, string> = {
  "webgl2-unavailable": "Safelight switched to software because the graphics card couldn't run WebGL2.",
  "gpu-crashes": "Safelight switched to software because the graphics driver kept crashing.",
  "renderer-failed": "Safelight switched to software because the graphics driver couldn't run its photo renderer.",
};

const noteCls = "mt-1 text-[10px] leading-relaxed text-text-secondary";

// The graphics backend is picked before the window exists, from a probe
// Safelight keeps in its config folder; the field shows once the bridge
// reports which one this launch uses.
function graphicsBackendSupported(): boolean {
  return privilegedGpu() !== null;
}

// The search index is built as this module loads, before boot claims the
// privileged bridge, so it only asks whether there is one to claim.
export function graphicsBackendListed(): boolean {
  return window.safelightNative?.claimPrivileged !== undefined;
}

// Automatic tries this platform's backends in order and moves to software by
// itself when the graphics card can't run WebGL2 or its driver keeps crashing,
// which a virtual machine often does. Any other entry pins that backend, for a
// driver that runs better on one than on the one Automatic settles on.
export function GraphicsBackendField() {
  const supported = graphicsBackendSupported();
  const [state, setState] = useState<NativeGpuBackendState | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // A change made here, as against a restart Safelight scheduled itself.
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    if (!supported) return;
    let live = true;
    void readGraphicsBackend()
      .then((s) => {
        if (live) setState(s);
      })
      .catch((err: unknown) => {
        console.warn("[safelight] couldn't read the graphics backend setting", err);
        if (live) setProblem("Couldn't read the graphics setting.");
      });
    return () => {
      live = false;
    };
  }, [supported]);

  if (!supported || (!state && !problem)) return null;

  const hint =
    "Automatic picks the first one that works on this graphics card, and switches to software when it fails. Pick another to try it if photos draw slowly or wrongly. Software works everywhere but is much slower.";

  if (!state) {
    return (
      <Field label={GRAPHICS_BACKEND} hint={hint}>
        <Select value={AUTOMATIC} onChange={() => {}} disabled ariaLabel={GRAPHICS_BACKEND} className="w-full" options={[{ value: AUTOMATIC, label: "Automatic" }]} />
        <p className={noteCls}>{problem}</p>
      </Field>
    );
  }

  const change = (value: string) => {
    setProblem(null);
    void chooseGraphicsBackend(value === AUTOMATIC ? null : value)
      .then((s) => {
        if (!s) return;
        setState(s);
        setChanged(true);
      })
      .catch((err: unknown) => {
        console.warn("[safelight] couldn't change the graphics backend setting", err);
        setProblem("Couldn't change the graphics setting.");
      });
  };
  const why = state.reason === null || state.reason === "chosen" ? null : SOFTWARE_REASON[state.reason];
  // The next start differs because of a change made here, or because Safelight
  // is moving this machine to software.
  const restart = state.next !== state.backend && (changed || (state.nextSoftware && !state.software));

  return (
    <Field label={GRAPHICS_BACKEND} hint={hint}>
      <Select
        value={state.choice ?? AUTOMATIC}
        onChange={change}
        ariaLabel={GRAPHICS_BACKEND}
        className="w-full"
        options={[
          { value: AUTOMATIC, label: "Automatic" },
          ...state.backends.map((b) => ({ value: b, label: backendLabel(b) })),
        ]}
      />
      <p className={noteCls}>Drawing with {backendLabel(state.backend)}.</p>
      {problem && <p className={noteCls}>{problem}</p>}
      {why && <p className={noteCls}>{why}</p>}
      {why && <p className={noteCls}>Pick Automatic again to try the graphics card at the next start.</p>}
      {restart && <p className={noteCls}>Takes effect when you restart Safelight.</p>}
    </Field>
  );
}
