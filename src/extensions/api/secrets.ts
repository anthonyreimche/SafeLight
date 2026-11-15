// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The shape of api.secrets: a sign-in token or a key kept encrypted.

/** Text an extension keeps secret, such as a sign-in's refresh token: each
 *  value is encrypted by the operating system's keychain (Windows' DPAPI, the
 *  macOS Keychain, the Secret Service or KWallet on Linux) and kept on this
 *  computer for this extension alone, across launches and updates. Uninstalling
 *  the extension forgets them. Where there is no keychain (Linux without one,
 *  the browser build) nothing is kept: `available` says so, `get` answers
 *  null and `set` rejects, so keep the value in memory for the session
 *  instead. Values stay out of plain-text files; like everything else an
 *  extension holds, they are not hidden from other code in the app. Needs
 *  Safelight 3.2.5. */
export interface SecretsAPI {
  /** Whether values can be kept here. */
  available(): Promise<boolean>;
  /** The value kept under `key`, or null: none kept, no keychain, or one the
   *  keychain can no longer read (the computer's account was reset). */
  get(key: string): Promise<string | null>;
  /** Keep `value` under `key` (1 to 64 letters, digits, dots, dashes or
   *  underscores), replacing what was there. At most 64 KiB of text. Rejects
   *  where there is no keychain ("NotSupportedError" in the browser build). */
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
