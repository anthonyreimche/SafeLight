// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Values extensions keep encrypted by the OS keychain (extension-secrets.cjs).
// Every channel is privileged: the page's core holds the bridge and names the
// asking extension itself (src/extensions/secrets.ts).

const { createExtensionSecrets } = require("../extension-secrets.cjs");

/**
 * @param {{
 *   safeStorage: Electron.SafeStorage,
 *   userData: () => string,
 *   fileWriter: { write: (p: string, bytes: Uint8Array) => Promise<void> },
 *   onUninstalled?: (forget: (id: string) => Promise<void>) => void,
 * }} deps
 */
function secretsChannels({ safeStorage, userData, fileWriter, onUninstalled }) {
  let secrets = null;
  const open = () => (secrets ??= createExtensionSecrets({ userData, fileWriter, safeStorage }));
  if (onUninstalled) onUninstalled((id) => open().forget(id));

  return [
    {
      channel: "secrets:available",
      privileged: true,
      handler: () => open().available(),
    },
    {
      channel: "secrets:get",
      privileged: true,
      handler: (_e, id, key) => open().get(String(id), String(key)),
    },
    {
      channel: "secrets:set",
      privileged: true,
      handler: (_e, id, key, value) => open().set(String(id), String(key), value),
    },
    {
      channel: "secrets:delete",
      privileged: true,
      handler: (_e, id, key) => open().delete(String(id), String(key)),
    },
  ];
}

module.exports = { secretsChannels };
