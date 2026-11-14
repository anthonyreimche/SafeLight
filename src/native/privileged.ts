// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Boot-time capture of the privileged native bridge — raw filesystem by absolute
// path, the in-app update installer, and installing and removing extensions. Extensions run as ESM in the *same*
// renderer realm as core, so anything reachable on window.safelightNative is also
// reachable by a malicious extension; the scoped SafelightAPI they're handed is
// not a security boundary. The window capture behind Report an issue is held the
// same way, and so is the switch for software rendering. The preload therefore exposes these surfaces only
// through a one-shot claimPrivileged() that returns the bundle on its first call
// and null thereafter. We claim it once, as early as possible at boot (before any
// extension — builtin or external — loads), and keep the reference module-private.
// Core reads it through privilegedFs()/privilegedUpdates()/privilegedPlugins()/privilegedCapture()/privilegedGpu()/privilegedOsOpen();
// extension code, which
// loads later, finds claimPrivileged() already spent and so can never reach it.

import type {
  NativeCaptureBridge,
  NativeDevtoolsBridge,
  NativeFsBridge,
  NativeGpuBridge,
  NativeNetBridge,
  NativeOsOpenBridge,
  NativePluginsBridge,
  NativeSecretsBridge,
  NativeSocketsBridge,
  NativeUpdatesBridge,
  NativeWindowBridge,
} from "@/extensions/types";

let claimed = false;
let fsBridge: NativeFsBridge | null = null;
let updatesBridge: NativeUpdatesBridge | null = null;
let pluginsBridge: NativePluginsBridge | null = null;
let captureBridge: NativeCaptureBridge | null = null;
let gpuBridge: NativeGpuBridge | null = null;
let osOpenBridge: NativeOsOpenBridge | null = null;
let windowBridge: NativeWindowBridge | null = null;
let devtoolsBridge: NativeDevtoolsBridge | null = null;
let netBridge: NativeNetBridge | null = null;
let secretsBridge: NativeSecretsBridge | null = null;
let socketsBridge: NativeSocketsBridge | null = null;

/** Claim the privileged bridge into module scope. Idempotent. Must run before
 *  the first extension loads — call it at the very top of renderer boot. */
export function claimPrivileged(): void {
  if (claimed) return;
  claimed = true;
  const priv = window.safelightNative?.claimPrivileged?.() ?? null;
  fsBridge = priv?.fs ?? null;
  updatesBridge = priv?.updates ?? null;
  pluginsBridge = priv?.plugins ?? null;
  captureBridge = priv?.capture ?? null;
  gpuBridge = priv?.gpu ?? null;
  osOpenBridge = priv?.osOpen ?? null;
  windowBridge = priv?.window ?? null;
  devtoolsBridge = priv?.devtools ?? null;
  netBridge = priv?.net ?? null;
  secretsBridge = priv?.secrets ?? null;
  socketsBridge = priv?.sockets ?? null;
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

/** The extension install/uninstall/settle bridge, or null outside Electron. */
export function privilegedPlugins(): NativePluginsBridge | null {
  if (!claimed) claimPrivileged();
  return pluginsBridge;
}

/** The window capture for Report an issue, or null outside Electron. */
export function privilegedCapture(): NativeCaptureBridge | null {
  if (!claimed) claimPrivileged();
  return captureBridge;
}

/** The graphics backend for the next launch, or null outside Electron. */
export function privilegedGpu(): NativeGpuBridge | null {
  if (!claimed) claimPrivileged();
  return gpuBridge;
}

/** The photo or folder the OS asked to open, or null outside Electron. */
export function privilegedOsOpen(): NativeOsOpenBridge | null {
  if (!claimed) claimPrivileged();
  return osOpenBridge;
}

/** The window material for a theme, or null outside Electron. */
export function privilegedWindow(): NativeWindowBridge | null {
  if (!claimed) claimPrivileged();
  return windowBridge;
}

/** Recording the Developer Tools dev folder, or null outside Electron. */
export function privilegedDevtools(): NativeDevtoolsBridge | null {
  if (!claimed) claimPrivileged();
  return devtoolsBridge;
}

/** Reaching the server addresses the person allowed an extension, or null
 *  outside Electron. */
export function privilegedNet(): NativeNetBridge | null {
  if (!claimed) claimPrivileged();
  return netBridge;
}

/** The secrets extensions keep encrypted by the OS keychain, or null outside
 *  Electron. */
export function privilegedSecrets(): NativeSecretsBridge | null {
  if (!claimed) claimPrivileged();
  return secretsBridge;
}

/** The live connections the person allowed an extension, or null outside
 *  Electron. */
export function privilegedSockets(): NativeSocketsBridge | null {
  if (!claimed) claimPrivileged();
  return socketsBridge;
}
