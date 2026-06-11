// Renders every registered panel for a sidebar slot, in contribution order.
// Sidebars stay dumb: panels appear/disappear as extensions (un)register.

import { useMemo } from "react";
import { panelsForSlot, useRegistry } from "./registry";
import { useDockStore } from "./dock";
import type { PanelSlot } from "./types";

export function PanelStack({ slot }: { slot: PanelSlot }) {
  const panels = useRegistry((s) => s.panels);
  const dockOpen = useDockStore((s) => s.open);
  // A panel floating in the dock leaves the sidebar — one instance at a time.
  const list = useMemo(
    () => panelsForSlot(panels, slot).filter((p) => !dockOpen.includes(p.id)),
    [panels, slot, dockOpen],
  );
  return (
    <>
      {list.map((p) => {
        const C = p.component;
        return <C key={p.id} />;
      })}
    </>
  );
}
