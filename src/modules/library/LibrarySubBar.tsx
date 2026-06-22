// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Mount point for extensions that want a bar directly below the Library
// toolbar (e.g. a search bar) via the "library-subbar" slot. It's a transparent
// passthrough — each contributed component supplies its own bar chrome, so it
// can collapse to nothing when it hides itself (no empty strip left behind).
// Renders nothing at all when no extension contributes.

import { useSlot } from "@/extensions/registry";

export function LibrarySubBar() {
  const items = useSlot("library-subbar");
  if (items.length === 0) return null;
  return (
    <>
      {items.map(({ id, component: C }) => (
        <C key={id} />
      ))}
    </>
  );
}
