// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Import worker shell: one thumbnail task per message, one result back. The
// pool sends a single task at a time per worker, so responses need no ids.

import {
  runThumbTask,
  type ThumbTaskInput,
  type ThumbTaskResult,
} from "./import-thumb-task";

const workerScope = self as unknown as {
  postMessage(msg: ThumbTaskResult): void;
};

self.onmessage = (e: MessageEvent<ThumbTaskInput>) => {
  void runThumbTask(e.data)
    .catch((): ThumbTaskResult => ({ ok: false }))
    .then((result) => workerScope.postMessage(result));
};
