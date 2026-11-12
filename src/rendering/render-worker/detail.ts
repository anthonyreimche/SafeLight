// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Dynamic detail in the live view. The develop renderer knows the size of the open
// photo's native frame, which the native frame worker holds and cuts from
// (native-frame-bridge.ts); this worker never cuts. Once the view has been still
// for DETAIL_SETTLE_MS with a window the held gain doesn't serve, the renderer's
// want goes to the window as detailWanted; the gain cut for it comes back with
// setDetailGain, and this worker draws a frame no render asked for, which the
// bridge shows like any other.

import { postLiveFrame, type HandlersFor, type WorkerContext } from "./context";

export const DETAIL_SETTLE_MS = 120;

/** The seq of a frame the worker draws unasked. The bridge's seqs start at 1. */
export const UNASKED_FRAME_SEQ = 0;

/** Asks for a gain for the live view once it has been still for
 *  DETAIL_SETTLE_MS, putting off an ask already pending. */
export function armDetailCut(ctx: WorkerContext): void {
  const { state } = ctx;
  cancelDetailCut(ctx);
  state.detailTimer = setTimeout(() => {
    state.detailTimer = null;
    askForDetail(ctx);
  }, DETAIL_SETTLE_MS);
}

/** Drops a pending ask, and a follow-up frame still to come: the photo changed,
 *  the native frame went, or a render the bridge asked for took over. */
export function cancelDetailCut({ state }: WorkerContext): void {
  if (state.detailTimer !== null) clearTimeout(state.detailTimer);
  state.detailTimer = null;
  cancelFollowUp(state);
}

function cancelFollowUp(state: WorkerContext["state"]): void {
  if (state.detailFollowUp !== null) clearTimeout(state.detailFollowUp);
  state.detailFollowUp = null;
}

/** A render the bridge asked for draws the view from here on, its own follow-ups
 *  included. */
export function yieldToAskedRender({ state }: WorkerContext): void {
  cancelFollowUp(state);
}

// The renderer decides afresh whether the view still wants a gain.
function askForDetail(ctx: WorkerContext): void {
  const { renderer } = ctx.state;
  if (!renderer || ctx.state.awaitingSource) return;
  const want = renderer.requestDetail();
  if (want) ctx.respond({ type: "detailWanted", ...want });
}

// A frame that put off mask copies' prepasses is followed by another, as the
// bridge follows a render it asked for; one that can't finish them stops at
// the next render the bridge asks for.
function showUnasked(ctx: WorkerContext): void {
  const { state } = ctx;
  const { renderer, canvas } = state;
  if (!renderer || !canvas || state.awaitingSource) return;
  postLiveFrame(ctx, renderer, canvas, { seq: UNASKED_FRAME_SEQ });
  if (!renderer.prepassPending) return;
  state.detailFollowUp = setTimeout(() => {
    state.detailFollowUp = null;
    showUnasked(ctx);
  }, 0);
}

type DetailCmd = "setNativeFrame" | "clearNativeFrame" | "setDetailGain";

export function detailHandlers(ctx: WorkerContext): HandlersFor<DetailCmd> {
  const { state } = ctx;
  return {
    setNativeFrame(msg) {
      const held = state.renderer?.setNativeFrame(msg.key, { width: msg.width, height: msg.height });
      if (held) armDetailCut(ctx);
      else cancelDetailCut(ctx);
    },

    clearNativeFrame() {
      cancelDetailCut(ctx);
      state.renderer?.clearNativeFrame();
    },

    setDetailGain(msg) {
      const { renderer } = state;
      if (!renderer) return;
      const { request, data, width, height, rect } = msg;
      const taken = renderer.setDetailGain(request, data ? { data, width, height, rect } : null);
      if (!taken) return;
      cancelFollowUp(state);
      showUnasked(ctx);
    },
  };
}
