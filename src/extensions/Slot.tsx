// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Renders every extension-contributed component for a named core UI slot.
// Generic mount point so extensions can inject chrome (e.g. a Library search
// bar) without core knowing what they are. Reactive: appears/disappears as
// extensions load, enable, or disable. `fallback` shows while nothing is in
// the slot.

import { memo, type ReactNode } from "react";
import { ErrorBoundary } from "@/ui/components/ErrorBoundary";
import { boundaryKey } from "./guard";
import { useSlot } from "./registry";
import type { SlotName } from "./types";

// Memoized: a slot draws again when its own contents change, not with every
// render of the view it sits in (Develop's canvas renders on each slider tick).
export const Slot = memo(function Slot({ name, fallback = null }: { name: SlotName; fallback?: ReactNode }) {
  const items = useSlot(name);
  if (items.length === 0) return <>{fallback}</>;
  return (
    <>
      {items.map(({ id, component: C }) => (
        <ErrorBoundary
          key={boundaryKey(id, C)}
          what={`Slot item "${id}"`}
          className="text-[11px] text-danger"
        >
          <C />
        </ErrorBoundary>
      ))}
    </>
  );
});
