// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// api.secrets: values an extension keeps encrypted by the OS keychain. On the
// desktop the main process encrypts and keeps them (electron/extension-secrets.cjs),
// over the privileged bridge core holds, so the id it names is the calling
// extension's own. The browser build has no keychain and keeps nothing.

import type { SecretsAPI } from "./api/secrets";
import { privilegedSecrets } from "@/native/privileged";

/** The secrets API of extension `extensionId`. */
export function secretsAPI(extensionId: string): SecretsAPI {
  return {
    available: async () => (await privilegedSecrets()?.available()) ?? false,
    get: async (key) => (await privilegedSecrets()?.get(extensionId, String(key))) ?? null,
    set: async (key, value) => {
      const secrets = privilegedSecrets();
      if (!secrets) throw new DOMException("Secrets can only be kept in the Safelight desktop app.", "NotSupportedError");
      await secrets.set(extensionId, String(key), String(value));
    },
    delete: async (key) => {
      await privilegedSecrets()?.delete(extensionId, String(key));
    },
  };
}
