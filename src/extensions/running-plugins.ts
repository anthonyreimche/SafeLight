// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { create } from "zustand";

// The installed extensions running in this window, kept by the loader. A leaf
// module, so the renderer's bridge and the photo geometry can read it without
// importing the loader.

/** The installed extensions running in this window, by id. */
export const useRunningPlugins = create<{ ids: string[] }>(() => ({ ids: [] }));
