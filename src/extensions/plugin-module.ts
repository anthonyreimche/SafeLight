// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The bundle import is the one step of plugin loading that jsdom cannot perform
// (an app:// URL served by the Electron protocol handler), so it stands alone
// here: the loader tests substitute this module and every other step runs for
// real.

import type { ExtensionModule } from "./types";

export const importPluginModule = (url: string): Promise<Partial<ExtensionModule>> =>
  import(/* @vite-ignore */ url) as Promise<Partial<ExtensionModule>>;
