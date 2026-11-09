// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Dedicated worker for the per-pixel work of a RAW decode (frame-job.ts). One
// request per message, the reply and its buffers sent straight back; frame-bridge.ts
// gives each worker one request at a time.

import { handleFrameRequest, type FrameReply, type FrameRequest } from "./frame-job";

const workerScope = self as unknown as {
  postMessage(msg: FrameReply, transfer: Transferable[]): void;
};

self.onmessage = (e: MessageEvent<FrameRequest>) => {
  const { reply, transfer } = handleFrameRequest(e.data);
  workerScope.postMessage(reply, transfer);
};
