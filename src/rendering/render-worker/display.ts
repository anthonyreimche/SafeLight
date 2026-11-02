// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// How the develop renderer shows its frames: the view's overlays, the zoom
// window, and the screen's profile, space and proof. Thumbnails are stored and
// take none of it.

import type { HandlersFor, WorkerContext } from "./context";

type DisplayCmd =
  | "setShowClipping"
  | "setOutsideColor"
  | "setMonitorTransform"
  | "setDisplaySpace"
  | "setProof"
  | "setMaskViz"
  | "setSharpenViz"
  | "setViewport";

export function displayHandlers({ state }: WorkerContext): HandlersFor<DisplayCmd> {
  return {
    setShowClipping(msg) {
      state.renderer?.setShowClipping(msg.mode);
    },
    setOutsideColor(msg) {
      state.renderer?.setOutsideColor(msg.rgb);
    },
    setMonitorTransform(msg) {
      state.latestMonitorTransform = msg.transform;
      state.renderer?.setMonitorTransform(msg.transform);
    },
    setDisplaySpace(msg) {
      state.latestDisplaySpace = msg.space;
      state.renderer?.setDisplaySpace(msg.space);
    },
    setProof(msg) {
      state.latestProof = msg.space;
      state.renderer?.setProofSpace(msg.space);
    },
    setMaskViz(msg) {
      state.renderer?.setMaskViz(msg.index, msg.color, msg.strength);
    },
    setSharpenViz(msg) {
      state.renderer?.setSharpenViz(msg.mode);
    },
    setViewport(msg) {
      state.renderer?.setViewport(msg.roi, msg.outW, msg.outH);
    },
  };
}
