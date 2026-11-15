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
  /** Why the next launch draws in software; null when it uses the graphics card. */
  softwareReason: NativeGpuBackendState["reason"];
  /** The notice was dismissed; it stays away for the rest of the session. */
  noticeDismissed: boolean;
  /** As `noticeDismissed`, for the notice that Safelight moved to software. */
  softwareNoticeDismissed: boolean;
  /** A graphics backend change this launch went back from, why, and the
   *  selection it went back to; null otherwise. */
  revert: { from: string; to: string; because: "failed" | "unkept" } | null;
  /** The change this launch is trying: the backend drawing, the selection it
   *  goes back to, and when unless kept (epoch ms); null otherwise. */
  keep: { drawing: string; back: string; by: number } | null;
  /** As `noticeDismissed`, for the notice that a change was undone. */
  revertNoticeDismissed: boolean;
}

export const useGraphics = create<GraphicsState>(() => ({
  webgl2: "unknown",
  reason: null,
  software: null,
  nextSoftware: null,
  softwareReason: null,
  noticeDismissed: false,
  softwareNoticeDismissed: false,
  revert: null,
  revertNoticeDismissed: false,
  keep: null,
}));

/** Preferences' Automatic entry, as the GPU bridge names it. */
export const AUTOMATIC = "auto";

const BACKEND_LABEL: Record<string, string> = {
  [AUTOMATIC]: "Automatic",
  gl: "OpenGL",
  gles: "OpenGL ES",
  vulkan: "Vulkan",
  d3d11: "Direct3D 11",
  d3d11on12: "Direct3D 11 on 12",
  "d3d11-warp": "WARP (processor)",
  metal: "Metal",
  swiftshader: "SwiftShader (processor)",
};

/** A graphics backend, or Automatic, as Preferences names it. */
export const backendLabel = (backend: string): string => BACKEND_LABEL[backend] ?? backend;

/** What the user reads once a backend change was undone. */
export function revertSentence(from: string, to: string, because: "failed" | "unkept"): string {
  const what =
    because === "unkept" ? `${backendLabel(from)} wasn't kept within 20 seconds` : `${backendLabel(from)} didn't work on this computer`;
  return `${what}, so Safelight went back to ${backendLabel(to)}.`;
}

/** Software Safelight moved to by itself, as against software the user picked. */
export type SoftwareFallback = Exclude<NativeGpuBackendState["reason"], "chosen" | null>;

export const SOFTWARE_REASON: Record<SoftwareFallback, string> = {
  "webgl2-unavailable": "Safelight switched to software because the graphics card couldn't run WebGL2.",
  "gpu-crashes": "Safelight switched to software because the graphics driver kept crashing.",
  "renderer-failed": "Safelight switched to software because the graphics driver couldn't run its photo renderer.",
};

export const GRAPHICS_CHANGE_FAILED = "Couldn't change the graphics setting.";

export const RESTART_FAILED = "Couldn't restart Safelight. Close it and open it again.";

export const GRAPHICS_UNAVAILABLE = "This computer can't run Safelight's image engine.";

/** The browser's own words for why WebGL2 didn't start: for a tooltip or a
 *  report, not the sentence the user reads. */
export function graphicsUnavailableDetail(reason: string | null): string {
  return `WebGL2 couldn't start${reason ? `: ${reason}` : ""}.`;
}

export const GRAPHICS_STILL_WORKS =
  "You can still browse, rate and organize photos; editing and export need graphics support.";

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
  if (state) {
    useGraphics.setState({
      software: state.software,
      nextSoftware: state.nextSoftware,
      softwareReason: state.reason,
      revert: state.reverted ? { ...state.reverted, to: state.choice ?? AUTOMATIC } : null,
      keep:
        state.keepBy !== null && state.revertTo !== null
          ? { drawing: state.backend, back: state.revertTo, by: state.keepBy }
          : null,
    });
  }
}

export async function readGpuBackend(): Promise<void> {
  takeBackend((await privilegedGpu()?.backend().catch(() => null)) ?? null);
}

/** Preferences ▸ Rendering ▸ Graphics backend: reads or changes the backend
 *  and keeps the notice's view of it current. Throws when the bridge does. */
export async function readGraphicsBackend(): Promise<NativeGpuBackendState | null> {
  const state = (await privilegedGpu()?.backend()) ?? null;
  takeBackend(state);
  return state;
}

export async function chooseGraphicsBackend(choice: string | null): Promise<NativeGpuBackendState | null> {
  const state = (await privilegedGpu()?.setBackend(choice)) ?? null;
  takeBackend(state);
  return state;
}

/** Asks the next launch to draw in software; it doesn't change this one. */
export async function trySoftwareRendering(): Promise<void> {
  takeBackend((await privilegedGpu()?.setSoftware(true).catch(() => null)) ?? null);
}

export function dismissGraphicsNotice(): void {
  useGraphics.setState({ noticeDismissed: true });
}

export function dismissSoftwareNotice(): void {
  useGraphics.setState({ softwareNoticeDismissed: true });
}

export function dismissRevertNotice(): void {
  useGraphics.setState({ revertNoticeDismissed: true });
}

/** Keeps the graphics backend change this launch is trying. Throws when the bridge does. */
export async function keepGraphicsChange(): Promise<void> {
  takeBackend((await privilegedGpu()?.keepChange()) ?? null);
}

/** The window can't start WebGL2 on the change this launch is trying: main
 *  sends the next launch back to the selection that last worked and offers
 *  the restart. Throws when the bridge does. */
export async function failGraphicsChange(detail: string): Promise<void> {
  takeBackend((await privilegedGpu()?.rendererFailed(detail)) ?? null);
}

/** Restarts Safelight, so a graphics change waiting on the next start applies.
 *  Throws when the bridge does. */
export async function restartSafelight(): Promise<void> {
  await privilegedGpu()?.restart();
}

/** Goes back from the graphics backend change this launch is trying; main
 *  restarts Safelight. Throws when the bridge does. */
export async function undoGraphicsChange(): Promise<void> {
  takeBackend((await privilegedGpu()?.revertChange()) ?? null);
}
