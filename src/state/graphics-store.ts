// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Whether this computer can start the image engine.
// Develop, Export and the main window's notice all explain a missing WebGL2 in
// the words below, so the user hears one explanation wherever it shows.

import { create } from "zustand";
import { privilegedGpu } from "@/native/privileged";
import type { NativeGpuBackendState } from "@/extensions/types";

export interface GraphicsState {
  webgl2: "unknown" | "yes" | "no";
  /** Why WebGL2 can't start, when it can't. */
  reason: string | null;
  /** This launch draws in software. Null where the GPU bridge reports no
   *  backend (in a browser). */
  software: boolean | null;
  /** The next launch draws in software. Null as for `software`. */
  nextSoftware: boolean | null;
  /** The notice was dismissed; it stays away for the rest of the session. */
  noticeDismissed: boolean;
}

export const useGraphics = create<GraphicsState>(() => ({
  webgl2: "unknown",
  reason: null,
  software: null,
  nextSoftware: null,
  noticeDismissed: false,
}));

export const GRAPHICS_UNAVAILABLE = "This computer can't run Safelight's image engine.";

/** The browser's own words for why WebGL2 didn't start: for a tooltip or a
 *  report, not the sentence the user reads. */
export function graphicsUnavailableDetail(reason: string | null): string {
  return `WebGL2 couldn't start${reason ? `: ${reason}` : ""}.`;
}

export const GRAPHICS_STILL_WORKS =
  "You can still browse, rate and organise photos; editing and export need graphics support.";

/** Tries a WebGL2 context. A missing WebGL2 is kept for the session; one that
 *  started is looked at again, since a GPU process that gives up takes it away. */
export function probeGraphics(): GraphicsState {
  const known = useGraphics.getState();
  if (known.webgl2 === "no") return known;
  let gl: WebGL2RenderingContext | null = null;
  let reason = "";
  try {
    const canvas = document.createElement("canvas");
    // Chromium says why a context couldn't be made on this event, during getContext.
    canvas.addEventListener("webglcontextcreationerror", (e) => {
      reason = (e as WebGLContextEvent).statusMessage;
    });
    gl = canvas.getContext("webgl2");
    // Browsers cap live contexts (~16); a probe left alive could evict the app's own.
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch (err) {
    reason ||= err instanceof Error ? err.message : String(err);
  }
  if (!gl) console.warn(`[graphics] ${graphicsUnavailableDetail(reason || "WebGL2 not supported")}`);
  useGraphics.setState(
    gl ? { webgl2: "yes", reason: null } : { webgl2: "no", reason: reason || "WebGL2 not supported" },
  );
  return useGraphics.getState();
}

function takeBackend(state: NativeGpuBackendState | null): void {
  if (state) useGraphics.setState({ software: state.software, nextSoftware: state.nextSoftware });
}

export async function readGpuBackend(): Promise<void> {
  takeBackend((await privilegedGpu()?.backend().catch(() => null)) ?? null);
}

/** Asks the next launch to draw in software; it doesn't change this one. */
export async function trySoftwareRendering(): Promise<void> {
  takeBackend((await privilegedGpu()?.setSoftware(true).catch(() => null)) ?? null);
}

export function dismissGraphicsNotice(): void {
  useGraphics.setState({ noticeDismissed: true });
}
