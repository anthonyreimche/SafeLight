// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Browse home's Starter kits shelf: a card per kit with something left to
// install. A card opens the kit's page.

import type { StarterKit } from "@/modules/welcome/setup/kits";
import { KitGlyph } from "@/modules/welcome/setup/KitGlyph";
import { SectionLabel } from "./StoreCards";

export function KitShelf({ kits, onOpen }: { kits: StarterKit[]; onOpen: (id: string) => void }) {
  if (kits.length === 0) return null;
  return (
    <div>
      <SectionLabel>Starter kits</SectionLabel>
      <div className="mt-1 flex gap-2 overflow-x-auto pb-1">
        {kits.map((k) => (
          <button
            key={k.id}
            onClick={() => onOpen(k.id)}
            className="flex w-44 shrink-0 items-start gap-2 rounded border border-border-subtle bg-surface-2 p-2 text-left text-text-secondary hover:bg-surface-3"
          >
            <KitGlyph icon={k.icon} />
            <span className="min-w-0">
              <span className="block truncate font-medium text-text-primary">{k.name}</span>
              <span className="block text-text-muted">
                {k.extensions.length} {k.extensions.length === 1 ? "extension" : "extensions"}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
