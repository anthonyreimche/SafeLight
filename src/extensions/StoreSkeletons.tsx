// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What the Extensions store shows while its text or cards are still on the way:
// breathing blocks in the shape of what arrives. The blocks wait out a quick load;
// the status text for screen readers is there at once.

import { Skeleton } from "@/ui/components/Skeleton";
import { useDelayedFlag } from "@/ui/use-delayed-flag";
import { EXPANDED_GRID } from "./StoreCards";

const LINE_WIDTHS = ["100%", "94%", "98%", "72%", "100%", "88%", "96%", "54%"];

/** Lines of text still loading: a README, release notes. */
export function TextSkeleton({ lines = 6, label = "Loading" }: { lines?: number; label?: string }) {
  const shown = useDelayedFlag(true);
  return (
    <div role="status">
      <span className="sr-only">{label}</span>
      {shown && (
        <div aria-hidden="true" className="sl-enter-fade flex flex-col gap-2">
          {Array.from({ length: lines }, (_, i) => (
            <Skeleton key={i} className="h-2.5" style={{ width: LINE_WIDTHS[i % LINE_WIDTHS.length] }} />
          ))}
        </div>
      )}
    </div>
  );
}

function CardSkeleton() {
  return (
    <div className="flex flex-col overflow-hidden rounded border border-border-subtle bg-surface-2">
      <Skeleton className="aspect-[2/1] w-full rounded-none" />
      <div className="flex flex-col gap-1.5 p-2">
        <Skeleton className="h-2.5 w-2/3" />
        <Skeleton className="h-2 w-full" />
        <Skeleton className="h-2 w-4/5" />
      </div>
    </div>
  );
}

/** A shelf of cards still loading, in the shelf's own layout. */
export function ShelfSkeleton({ expanded, label = "Searching" }: { expanded: boolean; label?: string }) {
  const shown = useDelayedFlag(true);
  return (
    <div role="status">
      <span className="sr-only">{label}</span>
      {shown && (
        <div aria-hidden="true" className="sl-enter-fade flex flex-col gap-1">
          <Skeleton className="h-2 w-16" />
          <div className={expanded ? EXPANDED_GRID : "flex gap-2 overflow-hidden"}>
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className={expanded ? "grid" : "w-44 shrink-0"}>
                <CardSkeleton />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
