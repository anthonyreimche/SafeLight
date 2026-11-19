// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Dedicated worker for HEIF decodes (heif-decode.ts), libheif loaded with it.
// One request per message, the reply and its buffers sent straight back;
// heif-bridge.ts gives each worker one request at a time and ends one whose
// libheif trapped.

import { answerHeifRequest, type HeifRequest } from "./heif-decode";
import { heifLib } from "./heif-lib";

const loadLib = () => Promise.resolve(heifLib());

self.onmessage = (e: MessageEvent<HeifRequest>) => {
  void answerHeifRequest(loadLib, e.data).then(({ reply, transfer }) => self.postMessage(reply, { transfer }));
};
