// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A param scope (mask-scope.tsx) as the extension that asked for it sees it:
// its commit makes the step in that extension's name (#281).

import { useMemo } from "react";
import { commitsAs } from "@/state/develop-store";
import type { ParamScope } from "@/modules/develop/mask-scope";

/** React hook: `scope` with its commit made for `extensionId`. */
export function scopeCommittingAs<S extends ParamScope>(extensionId: string, scope: S): S {
  return useMemo(
    () => ({ ...scope, commit: (label: string) => commitsAs(extensionId, () => scope.commit(label)) }),
    [extensionId, scope],
  );
}
