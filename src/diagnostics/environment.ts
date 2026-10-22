// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { detachedModule } from "@/state/detach";
import { isDevtoolsWindow } from "@/extensions/devtools/detach";
import { displayProfileSupported, useDisplayProfile } from "@/rendering/display-profile-store";
import type { EnvironmentFacts, GraphicsFacts, WebGLInfo } from "./report-sections";

/** Which kind of window this is: "main", a detached module's id, or "devtools". */
export function windowRole(): string {
  return detachedModule() ?? (isDevtoolsWindow() ? "devtools" : "main");
}

// Cached: the values are fixed per session, and a probe context left alive
// counts against the browser's ~16-context cap — enough refreshes would evict
// the app's real render context.
let webGLInfo: WebGLInfo | null | undefined;

export function readWebGLInfo(): WebGLInfo | null {
  if (webGLInfo !== undefined) return webGLInfo;
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") ||
      canvas.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return (webGLInfo = null);
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const vendor = dbg
      ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL))
      : String(gl.getParameter(gl.VENDOR));
    const renderer = dbg
      ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER));
    webGLInfo = {
      vendor,
      renderer,
      glsl: String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION)),
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    };
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return webGLInfo;
  } catch {
    return (webGLInfo = null);
  }
}

/** The running app's version: live from Electron, else the build-time value. */
export async function readAppVersion(): Promise<string> {
  try {
    const live = await window.safelightNative?.appVersion();
    if (live) return live;
  } catch {
    /* keep the build-time value */
  }
  return __APP_VERSION__ || "unknown";
}

export async function readEnvironment(): Promise<EnvironmentFacts> {
  const native = window.safelightNative;
  return {
    appVersion: await readAppVersion(),
    electron: native?.versions.electron ?? null,
    chrome: native?.versions.chrome ?? null,
    platform: native?.platform ?? navigator.platform,
    arch: native?.system?.arch ?? null,
    osVersion: native?.system?.osVersion ?? null,
    userAgent: navigator.userAgent,
    language: navigator.language,
    threads: navigator.hardwareConcurrency || null,
    screen: { width: screen.width, height: screen.height, dpr: window.devicePixelRatio },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    crossOriginIsolated: window.crossOriginIsolated === true,
    window: windowRole(),
  };
}

export async function readGraphics(): Promise<GraphicsFacts> {
  let gpuFeatures: Record<string, string> | null = null;
  try {
    gpuFeatures = (await window.safelightNative?.diagnostics?.gpuInfo()) ?? null;
  } catch {
    gpuFeatures = null;
  }
  return {
    webgl: readWebGLInfo(),
    gpuFeatures,
    displayProfile: displayProfileSupported() ? useDisplayProfile.getState().status : null,
  };
}
