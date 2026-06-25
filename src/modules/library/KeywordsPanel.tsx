// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useMemo, useState } from "react";
import { useCatalogStore } from "@/state/catalog-store";
import { useUIStore } from "@/state/ui-store";

export function KeywordsPanel() {
  const photos = useCatalogStore((s) => s.photos);
  const filter = useUIStore((s) => s.filter);
  const setFilter = useUIStore((s) => s.setFilter);
  const [search, setSearch] = useState("");

  const keywordCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of photos) {
      for (const k of p.keywords) {
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [photos]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return keywordCounts;
    return keywordCounts.filter(([k]) => k.toLowerCase().includes(q));
  }, [keywordCounts, search]);

  const activeSet = useMemo(() => new Set(filter.keywords), [filter.keywords]);

  const toggleKeyword = (keyword: string) => {
    if (activeSet.has(keyword)) {
      setFilter({ keywords: filter.keywords.filter((k) => k !== keyword) });
    } else {
      setFilter({ keywords: [...filter.keywords, keyword] });
    }
  };

  if (keywordCounts.length === 0) {
    return (
      <div className="px-3 py-3">
        <p className="text-[11px] text-text-muted">
          No keywords yet. Add keywords to photos in the Info panel.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 px-3 py-3">
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search keywords…"
        aria-label="Search keywords"
        className="w-full rounded bg-surface-2 px-2 py-1 text-[11px] text-text-primary placeholder:text-text-muted outline-none focus:ring-1 focus:ring-accent"
      />
      <div className="max-h-64 space-y-0.5 overflow-y-auto">
        {filtered.map(([keyword, count]) => (
          <button
            key={keyword}
            onClick={() => toggleKeyword(keyword)}
            className={`flex w-full items-center justify-between rounded px-2 py-1 text-[11px] ${
              activeSet.has(keyword)
                ? "bg-accent/20 text-text-primary"
                : "text-text-secondary hover:bg-surface-2 hover:text-text-primary"
            }`}
          >
            <span className="truncate">{keyword}</span>
            <span className="ml-2 shrink-0 text-text-muted">{count}</span>
          </button>
        ))}
      </div>
      {filter.keywords.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap gap-1">
            {filter.keywords.map((k) => (
              <span
                key={k}
                className="inline-flex items-center gap-0.5 rounded bg-accent/20 px-1.5 py-0.5 text-[10px] text-text-primary"
              >
                {k}
                <button
                  onClick={() => toggleKeyword(k)}
                  className="ml-0.5 text-text-muted hover:text-text-primary"
                  aria-label={`Remove ${k} from keyword filter`}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </span>
            ))}
          </div>
          <button
            onClick={() => setFilter({ keywords: [] })}
            className="w-full rounded bg-surface-2 px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-3 hover:text-text-primary"
          >
            Clear keyword filter
          </button>
        </div>
      )}
    </div>
  );
}
