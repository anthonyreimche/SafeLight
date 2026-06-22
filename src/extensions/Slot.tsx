// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Renders every extension-contributed component for a named core UI slot.
// Generic mount point so extensions can inject chrome (e.g. a Library search
// bar) without core knowing what they are. Reactive: appears/disappears as
// extensions load, enable, or disable.

import { useSlot } from "./registry";
import type { SlotName } from "./types";

export function Slot({ name }: { name: SlotName }) {
  const items = useSlot(name);
  return (
    <>
      {items.map(({ id, component: C }) => (
        <C key={id} />
      ))}
    </>
  );
}
