// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useEffect, useMemo, useRef, useState } from "react";
import { useCatalogStore } from "@/state/catalog-store";

export function KeywordEditor() {
  const photos = useCatalogStore((s) => s.photos);
  const selectedIds = useCatalogStore((s) => s.selectedIds);
  const activePhotoId = useCatalogStore((s) => s.activePhotoId);
  const addKeyword = useCatalogStore((s) => s.addKeyword);
  const removeKeyword = useCatalogStore((s) => s.removeKeyword);
  const addKeywords = useCatalogStore((s) => s.addKeywords);
  const removeKeywords = useCatalogStore((s) => s.removeKeywords);

  const [input, setInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const targetIds = useMemo(() => {
    if (selectedIds.size > 1) return [...selectedIds];
    if (activePhotoId) return [activePhotoId];
    return [];
  }, [selectedIds, activePhotoId]);

  const targetPhotos = useMemo(
    () => {
      const idSet = new Set(targetIds);
      return photos.filter((p) => idSet.has(p.id));
    },
    [photos, targetIds],
  );

  // Keywords shared by ALL target photos (intersection for multi-select display).
  const sharedKeywords = useMemo(() => {
    if (targetPhotos.length === 0) return [];
    if (targetPhotos.length === 1) return targetPhotos[0].keywords;
    const first = new Set(targetPhotos[0].keywords);
    for (let i = 1; i < targetPhotos.length; i++) {
      const kws = new Set(targetPhotos[i].keywords);
      for (const k of first) if (!kws.has(k)) first.delete(k);
    }
    return [...first];
  }, [targetPhotos]);

  // All unique keywords across the entire catalog, with counts.
  const allKeywords = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of photos) {
      for (const k of p.keywords) {
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    return counts;
  }, [photos]);

  // Autocomplete suggestions filtered by current input.
  const suggestions = useMemo(() => {
    const q = input.trim().toLowerCase();
    if (!q) return [];
    const existing = new Set(sharedKeywords.map((k) => k.toLowerCase()));
    return [...allKeywords.entries()]
      .filter(([k]) => k.toLowerCase().includes(q) && !existing.has(k.toLowerCase()))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
  }, [input, allKeywords, sharedKeywords]);

  useEffect(() => {
    setSelectedSuggestion(0);
  }, [suggestions.length]);

  // Close suggestions on outside click.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Focus from keyboard shortcut (K).
  useEffect(() => {
    const handler = () => inputRef.current?.focus();
    window.addEventListener("sl-focus-keyword-input", handler);
    return () => window.removeEventListener("sl-focus-keyword-input", handler);
  }, []);

  if (targetIds.length === 0) return null;

  const commitKeyword = (raw: string) => {
    const keyword = raw.trim();
    if (!keyword) return;
    if (targetIds.length > 1) {
      void addKeywords(targetIds, [keyword]);
    } else {
      void addKeyword(targetIds[0], keyword);
    }
    setInput("");
    setShowSuggestions(false);
  };

  const handleRemove = (keyword: string) => {
    if (targetIds.length > 1) {
      void removeKeywords(targetIds, [keyword]);
    } else {
      void removeKeyword(targetIds[0], keyword);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (showSuggestions && suggestions.length > 0) {
        commitKeyword(suggestions[selectedSuggestion][0]);
      } else {
        commitKeyword(input);
      }
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
      inputRef.current?.blur();
    } else if (e.key === "ArrowDown" && showSuggestions) {
      e.preventDefault();
      setSelectedSuggestion((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp" && showSuggestions) {
      e.preventDefault();
      setSelectedSuggestion((i) => Math.max(i - 1, 0));
    } else if (e.key === "Backspace" && input === "" && sharedKeywords.length > 0) {
      handleRemove(sharedKeywords[sharedKeywords.length - 1]);
    }
  };

  const multiLabel =
    targetIds.length > 1 ? (
      <span className="mb-1 text-[10px] text-text-muted">
        Editing {targetIds.length} photos (shared keywords)
      </span>
    ) : null;

  return (
    <div ref={containerRef} className="space-y-1">
      {multiLabel}
      <div className="flex flex-wrap gap-1">
        {sharedKeywords.map((k) => (
          <span
            key={k}
            className="inline-flex items-center gap-0.5 rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-text-secondary"
          >
            {k}
            <button
              onClick={() => handleRemove(k)}
              className="ml-0.5 text-text-muted hover:text-text-primary"
              aria-label={`Remove ${k}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="relative">
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setShowSuggestions(true);
          }}
          onFocus={() => setShowSuggestions(true)}
          onKeyDown={handleKeyDown}
          placeholder="Add keyword…"
          className="w-full rounded bg-surface-2 px-2 py-1 text-[11px] text-text-primary placeholder:text-text-muted outline-none focus:ring-1 focus:ring-accent"
        />
        {showSuggestions && suggestions.length > 0 && (
          <div className="absolute left-0 right-0 top-full z-50 mt-0.5 rounded border border-border bg-surface-1 py-0.5 shadow-lg">
            {suggestions.map(([keyword, count], i) => (
              <button
                key={keyword}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commitKeyword(keyword);
                }}
                onMouseEnter={() => setSelectedSuggestion(i)}
                className={`flex w-full items-center justify-between px-2 py-1 text-[11px] ${
                  i === selectedSuggestion
                    ? "bg-accent/20 text-text-primary"
                    : "text-text-secondary hover:bg-surface-2"
                }`}
              >
                <span>{keyword}</span>
                <span className="text-text-muted">{count}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
