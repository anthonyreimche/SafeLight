// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Entry of engine.html, the hidden page `slu` renders through. Kept tiny: the
// GUI's settings have to be in this profile's localStorage before any core
// module is imported, because modules read them as they load. So it waits for
// the port and the mirror the main process sends first, and only then imports
// the rest (boot.ts).

import { MIRRORED_STORAGE_KEYS, type SharedSettings } from "@/state/shared-settings";
import type { EngineChannel, PortMessage } from "./rpc";

export type StorageLike = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;

const SETTINGS_KEY = "sl_settings_v1";

function mirrored(key: string): boolean {
  return MIRRORED_STORAGE_KEYS.some((k) => (k.endsWith("*") ? key.startsWith(k.slice(0, -1)) : key === k));
}

/** Puts the GUI's mirrored settings in `storage` in place of the ones it held.
 *  The engine keeps them as the GUI has them, except that it never checks for
 *  or installs extension updates: installs are the GUI's and `slu install`'s. */
export function applyMirror(storage: StorageLike, mirror: SharedSettings | null): void {
  const stale: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null && mirrored(key)) stale.push(key);
  }
  for (const key of stale) storage.removeItem(key);
  for (const [key, value] of Object.entries(mirror?.storage ?? {})) {
    if (mirrored(key)) storage.setItem(key, value);
  }
  let settings: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(SETTINGS_KEY) ?? "{}");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
  } catch {
    // An unreadable copy is replaced; the settings store falls back to defaults.
  }
  storage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, checkExtensionUpdates: false, autoUpdateExtensions: false }));
}

/** The preload's stand-in for the port to the main process. Adding the first
 *  listener starts delivery. */
interface EnginePort {
  postMessage(message: PortMessage): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  close(): void;
}

/** What the preload gives engine.html, and only it. */
interface EngineNativeBridge {
  onPort(handler: (port: EnginePort) => void): void;
}

/** The port as an EngineChannel. Messages that arrive before boot listens are
 *  held for it. */
function channelOf(port: EnginePort, first: (data: unknown) => void): EngineChannel {
  let handler: ((data: unknown) => void) | null = null;
  const held: unknown[] = [];
  let firstSeen = false;
  port.addEventListener("message", ({ data }) => {
    if (!firstSeen) {
      firstSeen = true;
      first(data);
    } else if (handler) handler(data);
    else held.push(data);
  });
  return {
    send: (message: PortMessage) => port.postMessage(message),
    listen: (h) => {
      handler = h;
      for (const data of held.splice(0)) h(data);
    },
  };
}

function mirrorOf(data: unknown): SharedSettings | null {
  if (typeof data !== "object" || data === null) return null;
  const mirror = (data as { mirror?: unknown }).mirror;
  return typeof mirror === "object" && mirror !== null ? (mirror as SharedSettings) : null;
}

// The preload adds it only on engine.html, so the shared Window type leaves it out.
function engineBridge(): EngineNativeBridge | null {
  const engine: unknown = Reflect.get(window.safelightNative ?? {}, "engine");
  if (typeof engine !== "object" || engine === null) return null;
  return typeof Reflect.get(engine, "onPort") === "function" ? (engine as EngineNativeBridge) : null;
}

function start(): void {
  const engine = engineBridge();
  if (!engine) {
    console.error("[engine] no engine port: open engine.html from `slu`, not a browser");
    return;
  }
  engine.onPort((port) => {
    const channel = channelOf(port, (first) => {
      applyMirror(localStorage, mirrorOf(first));
      // The GUI's main window owns the main-window duties (the Essentials
      // migration and installs, the settings mirror, redrawing edited
      // thumbnails, the catalogue backup), so the engine names a role of its own.
      history.replaceState(history.state, "", `${location.pathname}?detached=engine`);
      void import("./boot").then(({ boot }) => boot(channel));
    });
  });
}

if (typeof window !== "undefined") start();
