// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Boot-time capture of the privileged native bridge — raw filesystem by absolute
// path, and the in-app update installer. Extensions run as ESM in the *same*
// renderer realm as core, so anything reachable on window.safelightNative is also
// reachable by a malicious extension; the scoped SafelightAPI they're handed is
// not a security boundary. The preload therefore exposes these two surfaces only
// through a one-shot claimPrivileged() that returns the bundle on its first call
// and null thereafter. We claim it once, as early as possible at boot (before any
// extension — builtin or external — loads), and keep the reference module-private.
// Core reads it through privilegedFs()/privilegedUpdates(); extension code, which
// loads later, finds claimPrivileged() already spent and so can never reach it.

import type { NativeFsBridge, NativeUpdatesBridge } from "@/extensions/types";

let claimed = false;
let fsBridge: NativeFsBridge | null = null;
let updatesBridge: NativeUpdatesBridge | null = null;

/** Claim the privileged bridge into module scope. Idempotent. Must run before
 *  the first extension loads — call it at the very top of renderer boot. */
export function claimPrivileged(): void {
  if (claimed) return;
  claimed = true;
  const priv = window.safelightNative?.claimPrivileged?.() ?? null;
  fsBridge = priv?.fs ?? null;
  updatesBridge = priv?.updates ?? null;
}

/** The privileged fs bridge, or null in the plain-browser build. Lazily claims
 *  on first use as a safety net, though boot should have claimed already. */
export function privilegedFs(): NativeFsBridge | null {
  if (!claimed) claimPrivileged();
  return fsBridge;
}

/** The privileged update-installer bridge, or null outside Electron. */
export function privilegedUpdates(): NativeUpdatesBridge | null {
  if (!claimed) claimPrivileged();
  return updatesBridge;
}
