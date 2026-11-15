// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useProjectStore } from "@/project/project-store";
import { useDelayedFlag } from "@/ui/use-delayed-flag";
import { ProgressBar } from "@/extensions/ui-kit";
import { LoadingDots } from "./LoadingDots";
import { Skeleton } from "./Skeleton";
import { TopBar } from "./TopBar";

const TILES = 24;

/** What the window shows from the click that opens a project until its catalogue is
 *  read, in place of the module's empty grid. The top bar stays; the rest waits out a
 *  quick open before it appears. */
export function OpeningVeil() {
  const name = useProjectStore((s) => s.openingName);
  const importDone = useProjectStore((s) => s.importDone);
  const importTotal = useProjectStore((s) => s.importTotal);
  const shown = useDelayedFlag(true);

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-hidden bg-surface-0 p-4">
        {shown && (
          <div className="sl-enter-fade flex min-h-0 flex-1 flex-col gap-3">
            <div role="status" className="text-sm text-text-secondary">
              <LoadingDots label={name ? `Opening ${name}` : "Opening"} />
            </div>
            {importTotal > 0 && <ProgressBar value={importDone / importTotal} label="Importing" />}
            <div className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(160px,1fr))] content-start gap-2 overflow-hidden">
              {Array.from({ length: TILES }, (_, i) => (
                <Skeleton key={i} className="aspect-square w-full" />
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
