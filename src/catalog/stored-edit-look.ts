// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { DevelopParams } from "./types";

/** The look one snapshot holds. `paramBag` is the extension param bag, keyed by
 *  qualified key like `EditSnapshot.paramBag`. */
export interface StoredLook { params: DevelopParams; paramBag: Record<string, unknown> }
