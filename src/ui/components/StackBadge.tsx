// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useVisibleStack } from "@/modules/library/photo-navigation";
import { useUIStore } from "@/state/ui-store";

/** The member count on a stacked photo's cell, or inline in its list row;
 *  clicking it expands or collapses the stack. Renders only for a photo in a
 *  stack the grid is showing. */
export function StackBadge({ photoId, inline = false }: { photoId: string; inline?: boolean }) {
  const stack = useVisibleStack(photoId);
  const toggleStack = useUIStore((s) => s.toggleStack);
  if (!stack) return null;
  const verb = stack.expanded ? "Collapse" : "Expand";
  return (
    <button
      type="button"
      aria-label={`${verb} stack of ${stack.size}`}
      title={`${verb} stack of ${stack.size}`}
      aria-expanded={stack.expanded}
      className={`flex items-center gap-0.5 rounded bg-black/50 px-1 text-[10px] leading-tight hover:bg-black/70 ${
        inline ? "shrink-0" : "absolute right-1 bottom-1 z-10"
      } ${stack.expanded ? "text-text-primary" : "text-text-secondary"}`}
      onClick={(e) => {
        e.stopPropagation();
        toggleStack(stack.stackId);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <span aria-hidden="true">{"⧉"}</span>
      <span>{stack.size}</span>
    </button>
  );
}
