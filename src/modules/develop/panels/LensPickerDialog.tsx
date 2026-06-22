// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useState, useMemo, useRef, useEffect } from "react";
import { loadLensDb, getCachedLensDb } from "@/lens-profiles/loader";
import type { LensfunLens } from "@/lens-profiles/types";

interface Props {
  onSelect: (lensId: string, lensName: string) => void;
  onClose: () => void;
}

export function LensPickerDialog({ onSelect, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [db, setDb] = useState<LensfunLens[]>(getCachedLensDb() ?? []);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (db.length === 0) {
      void loadLensDb().then(setDb);
    }
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    if (!query.trim()) return db.slice(0, 50);
    const lower = query.toLowerCase();
    const tokens = lower.split(/\s+/).filter(Boolean);
    return db
      .filter((lens) => {
        const text = `${lens.maker} ${lens.model}`.toLowerCase();
        return tokens.every((t) => text.includes(t));
      })
      .slice(0, 50);
  }, [query, db]);

  const grouped = useMemo(() => {
    const groups = new Map<string, LensfunLens[]>();
    for (const lens of filtered) {
      const list = groups.get(lens.maker) ?? [];
      list.push(lens);
      groups.set(lens.maker, list);
    }
    return groups;
  }, [filtered]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[400px] max-h-[500px] bg-[var(--color-surface-1)] rounded-lg border border-[var(--color-border)] shadow-xl flex flex-col">
        <div className="p-2 border-b border-[var(--color-border)]">
          <input
            ref={inputRef}
            type="text"
            placeholder="Search lenses..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full px-2 py-1 text-[12px] bg-[var(--color-surface-2)] text-[var(--color-text)] rounded border border-[var(--color-border)] outline-none focus:border-[var(--color-accent)]"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-1">
          {db.length === 0 && (
            <div className="text-[11px] text-[var(--color-text-tertiary)] text-center p-4">
              Loading lens database...
            </div>
          )}

          {db.length > 0 && filtered.length === 0 && (
            <div className="text-[11px] text-[var(--color-text-tertiary)] text-center p-4">
              No lenses matching "{query}"
            </div>
          )}

          {[...grouped.entries()].map(([maker, lenses]) => (
            <div key={maker} className="mb-1">
              <div className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wide px-1 py-0.5">
                {maker}
              </div>
              {lenses.map((lens) => (
                <button
                  key={lens.id}
                  className="w-full text-left px-2 py-1 text-[11px] text-[var(--color-text)] rounded hover:bg-[var(--color-surface-3)] transition-colors"
                  onClick={() => onSelect(lens.id, `${lens.maker} ${lens.model}`)}
                >
                  <span>{lens.model}</span>
                  {lens.focalMin > 0 && (
                    <span className="ml-1.5 text-[var(--color-text-tertiary)]">
                      {lens.focalMin === lens.focalMax
                        ? `${lens.focalMin}mm`
                        : `${lens.focalMin}-${lens.focalMax}mm`}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="p-2 border-t border-[var(--color-border)] flex justify-end">
          <button
            className="px-3 py-1 text-[11px] rounded bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)]"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
