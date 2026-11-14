// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Values an extension keeps secret (api.secrets): a sign-in's refresh token, a
// key. Each is encrypted with Electron's safeStorage, which the OS keychain
// guards (DPAPI on Windows, the Keychain on macOS, the Secret Service or
// KWallet on Linux), and kept per extension id in one file under userData.
// Where Linux has no keychain safeStorage falls back to a fixed key, which is
// no protection, so secrets count as unavailable there and nothing is written.
// The renderer reaches this through the privileged bridge only, which core
// wraps with the asking extension's own id. Like the rest of what extensions
// are handed this keeps values off the disk in plain text; it doesn't keep
// them from other code in the same page.

"use strict";

const path = require("node:path");
const fs = require("node:fs");

const VALID_KEY = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_VALUE_LENGTH = 64 * 1024;

/**
 * @param {{
 *   userData: () => string,
 *   fileWriter: { write: (p: string, bytes: Uint8Array) => Promise<void> },
 *   safeStorage: Pick<Electron.SafeStorage, "isEncryptionAvailable" | "encryptString" | "decryptString">
 *     & { getSelectedStorageBackend?: () => string },
 *   platform?: string,
 * }} deps
 */
function createExtensionSecrets({ userData, fileWriter, safeStorage, platform = process.platform }) {
  const file = () => path.join(userData(), "extension-secrets.json");
  /** extension id → (key → base64 ciphertext) */
  let saved = null;
  let damaged = false;

  function available() {
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (platform === "linux" && safeStorage.getSelectedStorageBackend?.() === "basic_text") return false;
    return true;
  }

  function load() {
    if (saved) return saved;
    let text;
    try {
      text = fs.readFileSync(file(), "utf8");
    } catch (e) {
      if (e && e.code === "ENOENT") return (saved = new Map());
      throw e;
    }
    const read = new Map();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* damaged, below */
    }
    if (parsed && parsed.version === 1 && parsed.secrets && typeof parsed.secrets === "object") {
      for (const [id, values] of Object.entries(parsed.secrets)) {
        if (!values || typeof values !== "object") continue;
        const kept = new Map(Object.entries(values).filter(([k, v]) => VALID_KEY.test(k) && typeof v === "string"));
        if (kept.size) read.set(id, kept);
      }
    } else damaged = true;
    return (saved = read);
  }

  async function save() {
    const out = {
      version: 1,
      secrets: Object.fromEntries([...load()].map(([id, values]) => [id, Object.fromEntries(values)])),
    };
    if (damaged) {
      await fs.promises.rename(file(), `${file()}.bad`);
      damaged = false;
    }
    await fileWriter.write(file(), new TextEncoder().encode(JSON.stringify(out)));
  }

  function checkKey(key) {
    if (typeof key !== "string" || !VALID_KEY.test(key)) throw new Error("A secret's key is 1 to 64 letters, digits, dots, dashes or underscores");
  }

  /** The value extension `id` kept under `key`, or null: none kept, no
   *  keychain, or one the keychain can no longer read (another user, a reset). */
  async function get(id, key) {
    if (typeof key !== "string" || !VALID_KEY.test(key) || !available()) return null;
    const cipher = load().get(String(id))?.get(key);
    if (!cipher) return null;
    try {
      return safeStorage.decryptString(Buffer.from(cipher, "base64"));
    } catch {
      return null;
    }
  }

  async function set(id, key, value) {
    checkKey(key);
    if (typeof value !== "string") throw new Error("A secret's value is text");
    if (value.length > MAX_VALUE_LENGTH) throw new Error("The secret is too large to keep");
    if (!available()) throw new Error("This computer has no keychain to keep secrets in");
    const values = load().get(String(id)) ?? new Map();
    values.set(key, safeStorage.encryptString(value).toString("base64"));
    load().set(String(id), values);
    await save();
  }

  async function remove(id, key) {
    const values = typeof key === "string" ? load().get(String(id)) : null;
    if (!values || !values.delete(key)) return;
    if (values.size === 0) load().delete(String(id));
    await save();
  }

  /** Forget every secret of extension `id`: it was uninstalled. */
  async function forget(id) {
    if (!load().delete(String(id))) return;
    await save();
  }

  return { available, get, set, delete: remove, forget };
}

module.exports = { createExtensionSecrets };
