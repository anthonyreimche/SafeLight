// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The render worker: one state, one handler per message, each area's in its own
// module under render-worker/.

import type { WorkerRequest, WorkerResponse } from "./render-protocol";
import { captureHandlers } from "./render-worker/capture";
import { initialState, messageOf, type Cmd, type Handler, type HandlersFor, type WorkerContext } from "./render-worker/context";
import { detailHandlers } from "./render-worker/detail";
import { displayHandlers } from "./render-worker/display";
import { liveHandlers } from "./render-worker/live";
import { sourceHandlers } from "./render-worker/sources";
import { thumbnailHandlers } from "./render-worker/thumbnails";

const workerScope = self as unknown as {
  postMessage(msg: unknown, transfer: Transferable[]): void;
  postMessage(msg: unknown): void;
};

function respond(msg: WorkerResponse, transfer?: Transferable[]) {
  if (transfer) {
    workerScope.postMessage(msg, transfer);
  } else {
    workerScope.postMessage(msg);
  }
}

const ctx: WorkerContext = {
  state: initialState(),
  respond,
  setBag: (target, bag) => target.setContributedParams(bag),
};

const handlers: HandlersFor<Cmd> = {
  ...liveHandlers(ctx),
  ...captureHandlers(ctx),
  ...thumbnailHandlers(ctx),
  ...sourceHandlers(ctx),
  ...displayHandlers(ctx),
  ...detailHandlers(ctx),
};

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    // Each handler takes its own command's message, which the table can't say
    // to the type checker for a message of any command. A command no handler
    // knows is ignored.
    const handle = handlers[msg.cmd] as Handler<Cmd> | undefined;
    handle?.(msg);
  } catch (err) {
    respond({ type: "error", message: messageOf(err) });
  }
};
