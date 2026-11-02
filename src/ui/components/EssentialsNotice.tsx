// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The top bar's word that some essentials didn't install on upgrade (offline,
// or a release that failed). Retry tries the missing ones again; the next
// launch would too.

import { retryEssentials, useEssentialsMigration } from "@/extensions/essentials-migration";
import { ESSENTIALS_KIT_ID } from "@/extensions/official-extensions";
import { openExtensionsOnKit } from "./extensions-dialog-store";

export const openEssentials = () => openExtensionsOnKit(ESSENTIALS_KIT_ID);

export function EssentialsNotice() {
  const failed = useEssentialsMigration((s) => s.status === "failed");
  if (!failed) return null;
  return (
    <div role="status" className="flex items-center gap-2 text-[11px] text-text-secondary">
      <span className="text-danger" aria-hidden="true">
        ⚠
      </span>
      <span className="text-text-primary">Some essentials couldn't be installed.</span>
      <button
        onClick={() => void retryEssentials()}
        className="rounded bg-slider-fill px-2.5 py-1 text-[11px] font-medium text-white hover:opacity-90"
      >
        Retry
      </button>
      <button
        onClick={openEssentials}
        className="rounded border border-border px-2.5 py-1 text-[11px] text-text-primary hover:bg-surface-3"
      >
        Manage extensions
      </button>
    </div>
  );
}
