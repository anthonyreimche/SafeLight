// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Dedicated worker that holds the open photo's native luminance and cuts detail
// gains from it (native-frame-job.ts), so a cut never holds up the render
// worker's frames or the window. native-frame-bridge.ts sends it one cut at a time.

import { NativeFrameHolder, type NativeFrameRequest } from "./native-frame-job";

const holder = new NativeFrameHolder();

self.onmessage = (e: MessageEvent<NativeFrameRequest>) => {
  const answer = holder.handle(e.data);
  if (answer) self.postMessage(answer.reply, { transfer: answer.transfer });
};
