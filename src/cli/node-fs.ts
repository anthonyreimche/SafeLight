// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// NativeFsBridge in plain Node, over electron/fs-bridge.cjs.

import { randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import { createAtomicWriter } from "../../electron/atomic-write.cjs";
import { createFsBridge } from "../../electron/fs-bridge.cjs";
import type { NativeFsBridge } from "@/extensions/api/native-bridge";
import { readSharedSettings } from "./mirror";

const SETTINGS_KEY = "sl_settings_v1";

/** The "Separate catalogue location" the app has set, or "" for its default. */
export function catalogueBase(userData: string): string {
  const raw = readSharedSettings(userData)?.storage[SETTINGS_KEY];
  if (!raw) return "";
  try {
    const settings: unknown = JSON.parse(raw);
    if (typeof settings !== "object" || settings === null) return "";
    const base = (settings as { externalCatalogDir?: unknown }).externalCatalogDir;
    return typeof base === "string" ? base : "";
  } catch {
    return "";
  }
}

// Windows briefly locks a file the indexer or antivirus is reading.
const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);

async function retry<T>(op: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await op();
    } catch (e) {
      if (attempt >= 5 || !TRANSIENT.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/** The process's one writer, as Safelight main has one: writes to one file stay in order. */
export const fileWriter = createAtomicWriter({ fsp, randomId: () => randomBytes(8).toString("hex"), retry });

export function createNodeFsBridge(userData: string): NativeFsBridge {
  const bridge = createFsBridge({ userData, baseOverride: () => catalogueBase(userData), writer: fileWriter });
  return { ...bridge, pickDirectory: async () => null, reveal: async () => false };
}
