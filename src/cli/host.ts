// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The window and localStorage shims core code needs in plain Node. Installed
// before any core module is imported.

import type { NativeFsBridge } from "@/extensions/api/native-bridge";

export interface NodeHostOptions {
  bridge: NativeFsBridge;
  platform: NodeJS.Platform;
  /** localStorage contents, from the shared-settings mirror. */
  storage: Record<string, string>;
}

/** A localStorage held in memory: seeded from the mirror, never written back. */
class MemoryStorage implements Storage {
  private readonly entries: Map<string, string>;

  constructor(seed: Record<string, string>) {
    this.entries = new Map(Object.entries(seed));
  }

  get length(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, String(value));
  }

  [name: string]: unknown;
}

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

// Core claims the privileged bridge once per process (native/privileged.ts), so
// the bridge it claims forwards to the one the latest install named.
let current: NativeFsBridge | null = null;
const forwarding = new Proxy({} as NativeFsBridge, {
  get(_target, key) {
    if (!current) return undefined;
    const value: unknown = Reflect.get(current, key);
    return typeof value === "function" ? value.bind(current) : value;
  },
  has: (_target, key) => current !== null && key in current,
});

export function installNodeHost({ bridge, platform, storage }: NodeHostOptions): void {
  current = bridge;
  const localStorage = new MemoryStorage(storage);
  define("localStorage", localStorage);
  define("window", {
    localStorage,
    safelightNative: { platform, claimPrivileged: () => ({ fs: forwarding }) },
  });
}
