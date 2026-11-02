// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useEffect, useRef, useState } from "react";
import { nativeFs } from "@/project/native-fs";
import { useSettings } from "@/state/settings-store";
import type { ExternalCatalogEntry } from "@/extensions/types";
import { btnCls, Field, useFieldVisible } from "@/ui/preferences/fields";

/** Human-readable byte size (1 KB = 1024 B). */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Lists the "separate" catalogs Safelight keeps outside photo folders (read-only
 *  sources + Separate-folder projects) so the user can see what's on disk and
 *  reclaim space. Deleting one drops that project's edits/ratings/cache — the
 *  photos are never touched — so it's behind a per-row confirm. Renders nothing on
 *  builds whose bridge predates listExternalCatalogs. */
const STORED_CATALOGS_HINT =
  "Catalogs kept outside photo folders — for read-only sources and Separate-folder projects. Deleting one removes that project's saved edits, ratings, previews and cache; the photos themselves are untouched.";

export function StoredCatalogsField() {
  const s = useSettings();
  const fs = nativeFs();
  const visible = useFieldVisible("Stored catalogs", STORED_CATALOGS_HINT);
  const [items, setItems] = useState<ExternalCatalogEntry[] | null>(null);
  const [confirmPath, setConfirmPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => void (mountedRef.current = false);
  }, []);

  useEffect(() => {
    // Skip the (potentially gigabytes-wide) recursive disk walk unless the field
    // is both supported and actually on screen — preferences search mounts the
    // whole Previews section even when this field is filtered out of the results.
    if (!visible || !fs?.listExternalCatalogs) return;
    let cancelled = false;
    setItems(null);
    void (async () => {
      // Catalogs can sit under the app-data default and/or the chosen base; query
      // both and dedupe by path so a freshly-changed base still shows old ones.
      const bases = Array.from(new Set(["", s.externalCatalogDir.trim()]));
      const lists = await Promise.all(
        bases.map((b) => fs.listExternalCatalogs!(b || null).catch(() => [])),
      );
      if (cancelled) return;
      const byPath = new Map<string, ExternalCatalogEntry>();
      for (const list of lists) for (const it of list) byPath.set(it.path, it);
      setItems([...byPath.values()].sort((a, b) => b.bytes - a.bytes));
    })();
    return () => {
      cancelled = true;
    };
  }, [fs, s.externalCatalogDir, visible]);

  if (!visible || !fs?.listExternalCatalogs) return null;

  const del = async (it: ExternalCatalogEntry) => {
    setBusy(true);
    try {
      await fs.remove(it.path);
      // Also drop its spillover pointer so no stale breadcrumb lingers (best-effort;
      // a leftover pointer is harmless — the marker re-check makes it a no-op).
      if (it.sourcePath && fs.clearSpilloverPointer)
        await fs.clearSpilloverPointer(it.sourcePath).catch(() => {});
      // Drop the row locally instead of re-walking every remaining catalog.
      if (mountedRef.current)
        setItems((prev) => prev?.filter((e) => e.path !== it.path) ?? prev);
    } finally {
      if (mountedRef.current) {
        setBusy(false);
        setConfirmPath(null);
      }
    }
  };

  return (
    <Field label="Stored catalogs" hint={STORED_CATALOGS_HINT}>
      <div className="flex flex-col gap-1">
        {items === null ? (
          <span className="text-[10px] text-text-muted">Scanning…</span>
        ) : items.length === 0 ? (
          <span className="text-[10px] text-text-muted">None stored yet.</span>
        ) : (
          items.map((it) => (
            <div
              key={it.path}
              className="flex items-center gap-1.5 rounded bg-surface-2 px-2 py-1"
            >
              <div className="min-w-0 flex-1">
                <div
                  className="truncate text-[11px] text-text-secondary"
                  title={it.sourcePath ?? it.path}
                >
                  {it.sourcePath ?? it.name}
                </div>
                <div className="text-[10px] text-text-muted">
                  {[
                    formatBytes(it.bytes),
                    it.photoCount != null &&
                      `${it.photoCount} ${it.photoCount === 1 ? "photo" : "photos"}`,
                    it.lastOpenedAt != null &&
                      `opened ${new Date(it.lastOpenedAt).toLocaleDateString()}`,
                    !it.sourcePath && "source unknown",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                {it.sampleNames && it.sampleNames.length > 0 && (
                  <div className="truncate text-[10px] text-text-muted">
                    {it.sampleNames.join(", ")}
                  </div>
                )}
              </div>
              <button className={btnCls} onClick={() => void fs.reveal(it.path)}>
                Reveal
              </button>
              {confirmPath === it.path ? (
                <>
                  <button
                    className={btnCls}
                    disabled={busy}
                    onClick={() => void del(it)}
                  >
                    {busy ? "Deleting…" : "Confirm delete"}
                  </button>
                  <button className={btnCls} onClick={() => setConfirmPath(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button className={btnCls} onClick={() => setConfirmPath(it.path)}>
                  Delete
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </Field>
  );
}
