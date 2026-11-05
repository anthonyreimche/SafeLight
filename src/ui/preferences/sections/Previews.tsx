// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useState, type Dispatch, type SetStateAction } from "react";
import { updateSettings, useSettings, type PreviewSource } from "@/state/settings-store";
import { useCatalogStore } from "@/state/catalog-store";
import { clearRawCache } from "@/raw/raw-cache";
import { isNativeFS, nativeFs } from "@/project/native-fs";
import { projectPassSignal } from "@/project/project-store";
import {
  EAGER_CACHE_LIMIT,
  preDecodeRawsForCache,
  rebuildThumbnails,
} from "@/modules/library/import-photos";
import { btnCls, Field, labelCls, OptionRow, ToggleField } from "@/ui/preferences/fields";
import { settings, type PrefSection } from "@/ui/preferences/section-model";
import { StoredCatalogsField } from "./StoredCatalogsField";

// Cache-mode tri-state derived from two booleans: caching off, or on with/without
// the eager full-catalogue prefetch. Stored as two flags so existing settings
// migrate for free (rawCacheEnabled stays meaningful; prefetch defaults on).
type CacheMode = "eager" | "ondemand" | "off";

// A Previews pass the user started: how far it got, and whether leaving the
// project (opening another, or closing it) stopped it before the end. It shows
// as stopped at once: the work already under way may take minutes to finish,
// and what it reports after the stop is ignored.
interface PassProgress {
  done: number;
  total: number;
  stopped?: boolean;
}

const STOPPED_NOTE = "Stopped.";

// failed: how many cached previews could not be cleared; null when the cache
// could not be reached at all.
interface ClearOutcome {
  failed: number | null;
}

const clearFailureNote = (failed: number | null): string =>
  failed === null
    ? "Couldn't clear the preview cache."
    : `Couldn't clear ${failed} cached ${failed === 1 ? "preview" : "previews"}.`;

const passRunning = (p: PassProgress | null): boolean =>
  p !== null && !p.stopped && p.done < p.total;

// A run that had already reached its end stays finished.
const stoppedEarly = (p: PassProgress | null): PassProgress | null =>
  p && p.done < p.total ? { ...p, stopped: true } : p;

/** The progress callback for a pass on the open project: it shows the pass as
 *  stopped as soon as `signal` aborts, and takes no report after that. */
function passProgress(
  show: Dispatch<SetStateAction<PassProgress | null>>,
  signal: AbortSignal | undefined,
): (done: number, total: number) => void {
  signal?.addEventListener("abort", () => show(stoppedEarly), { once: true });
  return (done, total) => {
    if (!signal?.aborted) show({ done, total });
  };
}

export function PreviewsSection() {
  const s = useSettings();
  const cacheMode: CacheMode = !s.rawCacheEnabled
    ? "off"
    : s.rawCachePrefetch
      ? "eager"
      : "ondemand";

  const [cleared, setCleared] = useState<ClearOutcome | null>(null);
  const [rebuild, setRebuild] = useState<PassProgress | null>(null);
  const rebuilding = passRunning(rebuild);
  const handleRebuild = () => {
    const photos = useCatalogStore.getState().photos;
    if (photos.length === 0 || rebuilding) return;
    setRebuild({ done: 0, total: photos.length });
    const signal = projectPassSignal();
    void rebuildThumbnails(
      photos,
      passProgress(setRebuild, signal),
      (p, change) => useCatalogStore.getState().mergeRebuiltPhoto(p.id, change),
      signal,
    );
  };

  const [cacheAll, setCacheAll] = useState<PassProgress | null>(null);
  const cachingAll = passRunning(cacheAll);
  const handleCacheAll = () => {
    const photos = useCatalogStore.getState().photos;
    if (photos.length === 0 || cachingAll || !s.rawCacheEnabled) return;
    setCacheAll({ done: 0, total: 1 }); // placeholder until the real count lands
    const signal = projectPassSignal();
    void preDecodeRawsForCache(photos, {
      force: true,
      onProgress: passProgress(setCacheAll, signal),
      signal,
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Preview source"
        hint="How RAW grid previews are built. Embedded uses the camera's JPEG (fastest). Rendered always decodes the RAW (neutral, slower). Auto uses the embedded JPEG when it's already sharp enough, else renders."
      >
        <OptionRow
          value={s.previewSource}
          options={[
            { value: "auto", label: "Auto" },
            { value: "embedded", label: "Embedded JPEG" },
            { value: "rendered", label: "Rendered" },
          ]}
          onChange={(v) => updateSettings({ previewSource: v as PreviewSource })}
        />
      </Field>
      <Field
        label="Thumbnail quality"
        hint="Long edge of rendered grid thumbnails. Higher is sharper but slower; takes effect on newly rendered thumbnails."
      >
        <OptionRow
          value={s.thumbMaxEdge}
          options={[
            { value: 320, label: "Fast (320px)" },
            { value: 640, label: "Balanced (640px)" },
            { value: 960, label: "Sharp (960px)" },
          ]}
          onChange={(v) =>
            updateSettings({ thumbMaxEdge: v as 320 | 640 | 960 })
          }
        />
      </Field>
      <ToggleField
        label="Store previews on disk"
        hint="Save grid previews in the project's .safelight/previews folder so they load instantly next open. Off keeps the folder small but rebuilds previews on demand each open."
        checked={s.persistPreviews}
        onChange={(v) => updateSettings({ persistPreviews: v })}
      />
      <Field
        label="Grid thumbnails"
        hint="Re-decodes every photo in the open project and regenerates its grid thumbnail at the current Thumbnail quality. Use after changing the settings above."
      >
        <button onClick={handleRebuild} disabled={rebuilding} className={btnCls}>
          {rebuilding ? "Rebuilding…" : "Rebuild thumbnails"}
        </button>
        {rebuild !== null && (
          <span className="ml-2 text-[10px] text-text-muted">
            {rebuild.stopped
              ? STOPPED_NOTE
              : rebuilding
                ? `${rebuild.done} / ${rebuild.total}`
                : `Rebuilt ${rebuild.total}.`}
          </span>
        )}
      </Field>

      <div className="border-t border-border-subtle pt-3">
        <div className={labelCls}>Develop cache</div>
      </div>
      <Field
        label="Cache decoded RAW previews"
        hint={`Re-opening a photo in Develop loads in ~50ms instead of re-decoding (3–8s). Cache all decodes the uncached photos on open, up to ${EAGER_CACHE_LIMIT.toLocaleString()} at a time (a larger project caches as you open photos, or use Cache all now); As needed only caches photos as you open them; Off never caches.`}
      >
        <OptionRow
          value={cacheMode}
          options={[
            { value: "eager", label: "Cache all" },
            { value: "ondemand", label: "As needed" },
            { value: "off", label: "Off" },
          ]}
          onChange={(v) => {
            if (v === "off") updateSettings({ rawCacheEnabled: false });
            else
              updateSettings({
                rawCacheEnabled: true,
                rawCachePrefetch: v === "eager",
              });
          }}
        />
      </Field>
      <Field
        label="Cached preview resolution"
        hint="Long-edge cap of cached previews. Develop edits render from this cached preview; exports larger than the cap re-decode the full RAW."
      >
        <OptionRow
          value={s.rawCacheMaxEdge}
          options={[
            { value: 2048, label: "2048 px" },
            { value: 3072, label: "3072 px" },
            { value: 4096, label: "4096 px" },
          ]}
          onChange={(v) =>
            updateSettings({ rawCacheMaxEdge: v as 2048 | 3072 | 4096 })
          }
        />
      </Field>
      <Field
        label="Cache storage"
        hint="Cache all photos in the open project now, or clear the cached previews for all projects to reclaim disk space."
      >
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleCacheAll}
            disabled={cachingAll || !s.rawCacheEnabled}
            className={btnCls}
          >
            {cachingAll ? "Caching…" : "Cache all now"}
          </button>
          <button
            onClick={() => {
              setCleared(null);
              void clearRawCache().then(
                ({ failed }) => setCleared({ failed }),
                () => setCleared({ failed: null }),
              );
            }}
            className={btnCls}
          >
            Clear preview cache
          </button>
        </div>
        {cacheAll !== null && (
          <span className="ml-2 text-[10px] text-text-muted">
            {cacheAll.stopped
              ? STOPPED_NOTE
              : cachingAll
                ? `${cacheAll.done} / ${cacheAll.total}`
                : cacheAll.total === 0
                  ? "Already cached."
                  : `Cached ${cacheAll.total}.`}
          </span>
        )}
        {cleared !== null &&
          (cleared.failed === 0 ? (
            <span className="ml-2 text-[10px] text-text-muted">Cleared.</span>
          ) : (
            <span className="ml-2 text-[10px] text-danger">{clearFailureNote(cleared.failed)}</span>
          ))}
      </Field>

      {isNativeFS() && (
        <>
          <div className="border-t border-border-subtle pt-3">
            <div className={labelCls}>Catalogue storage</div>
          </div>
          <Field
            label="Catalogue location"
            hint="Where each project's working data (catalogue, previews, cache) lives. In photo folder keeps it beside the photos; a read-only source like a memory card falls back to the separate location automatically. Separate folder always stores it there — keeps photo folders clean and is handy on a fast SSD. Applies to folders opened for the first time. Existing catalogues stay where they are."
          >
            <OptionRow
              value={s.catalogLocation}
              options={[
                { value: "in-folder", label: "In photo folder" },
                { value: "external", label: "Separate folder" },
              ]}
              onChange={(v) =>
                updateSettings({ catalogLocation: v as "in-folder" | "external" })
              }
            />
          </Field>
          <Field
            label="Separate catalogue location"
            hint="Where Separate folder catalogues — and the automatic fallback for read-only sources — are stored. Each source folder gets its own subfolder, keyed by path so it's stable across opens. Default: the app's data directory."
          >
            <div className="flex items-center gap-1.5">
              <span
                className="min-w-0 flex-1 truncate rounded bg-surface-2 px-2 py-1 text-[11px] text-text-secondary"
                title={s.externalCatalogDir || undefined}
              >
                {s.externalCatalogDir || "App data folder (default)"}
              </span>
              <button
                onClick={() => {
                  void nativeFs()
                    ?.pickDirectory()
                    .then((dir) => {
                      if (dir) updateSettings({ externalCatalogDir: dir });
                    });
                }}
                className={btnCls}
              >
                Choose folder…
              </button>
              {s.externalCatalogDir && (
                <button
                  onClick={() => updateSettings({ externalCatalogDir: "" })}
                  className={btnCls}
                >
                  Use default
                </button>
              )}
            </div>
          </Field>
          <StoredCatalogsField />
        </>
      )}
    </div>
  );
}

export const previewsSection: PrefSection = {
  id: "Previews",
  label: "Previews",
  group: "General",
  items: settings(
    "Preview source",
    "Thumbnail quality",
    "Store previews on disk",
    "Grid thumbnails",
    "Cache decoded RAW previews",
    "Cached preview resolution",
    "Cache storage",
    "Catalogue location",
    "Separate catalogue location",
    "Stored catalogues",
  ),
  keywords: [
    "Embedded JPEG",
    "Rebuild thumbnails",
    "Clear preview cache",
    "catalogue storage",
    "read-only",
    "memory card",
    "sd card",
    "ssd",
    "reclaim disk",
    "orphaned catalogue",
    "catalog storage",
    "catalog location",
    "stored catalogs",
    "orphaned catalog",
  ],
  render: () => <PreviewsSection />,
};
