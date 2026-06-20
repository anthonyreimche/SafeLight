// UI state for the Extensions "store" window: which view (list ↔ detail), the
// selected extension, the active category/sort/search, and caches for the data
// the detail view and the update checker fetch from GitHub. Kept separate from
// the contribution registry and the enable/disable loader state. Lifting the
// caches here lets the background launch check (loader.ts) populate update info
// before the dialog is ever opened, and avoids prop-drilling through the panel.

import { create } from "zustand";
import type { ExtensionRepoMeta } from "./types";

export type StoreSort = "popular" | "updated" | "name";

/** A fetch that's in flight, resolved, or failed. */
export type Async<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: string };

/** Latest-version check for one installed extension. */
export interface ExtUpdateInfo {
  /** Newest release tag found on GitHub, or null if none / no repo. */
  latestTag: string | null;
  /** True when latestTag is strictly newer than the installed version. */
  hasUpdate: boolean;
  /** Epoch ms of the check, so we can skip re-checking too often. */
  checkedAt: number;
}

// ── Category mapping ─────────────────────────────────────────────────────────
// Categories are derived from GitHub repo topics so authors get them for free.

const TOPIC_CATEGORY: Record<string, string> = {
  "safelight-panel": "Panels",
  "safelight-export": "Export",
  "safelight-preset": "Presets",
  "safelight-color": "Color",
  "safelight-theme": "Themes",
  "safelight-pipeline": "Pipelines",
};

/** Display order for the category chips. "All" is the unfiltered default. */
export const CATEGORY_ORDER = [
  "All",
  "Panels",
  "Export",
  "Presets",
  "Color",
  "Themes",
  "Pipelines",
  "Other",
] as const;

/** First matching topic's category, or explicit manifest categories, else "Other". */
export function categoryFor(topics?: string[], manifestCategories?: string[]): string {
  for (const c of manifestCategories ?? [])
    if ((CATEGORY_ORDER as readonly string[]).includes(c)) return c;
  for (const t of topics ?? []) if (TOPIC_CATEGORY[t]) return TOPIC_CATEGORY[t];
  return "Other";
}

interface ExtStoreUI {
  view: "list" | "detail";
  /** Selected extension: a repo "owner/repo" or a built-in id like "core.histogram". */
  selected: string | null;
  category: string;
  sort: StoreSort;
  meta: Record<string, Async<ExtensionRepoMeta>>;
  readme: Record<string, Async<string | null>>;
  updates: Record<string, ExtUpdateInfo>;

  openDetail: (selected: string) => void;
  back: () => void;
  setCategory: (c: string) => void;
  setSort: (s: StoreSort) => void;
  setUpdate: (id: string, info: ExtUpdateInfo) => void;
}

export const useExtStoreUI = create<ExtStoreUI>((set) => ({
  view: "list",
  selected: null,
  category: "All",
  sort: "popular",
  meta: {},
  readme: {},
  updates: {},

  openDetail: (selected) => set({ selected, view: "detail" }),
  back: () => set({ view: "list", selected: null }),
  setCategory: (category) => set({ category }),
  setSort: (sort) => set({ sort }),
  setUpdate: (id, info) =>
    set((s) => ({ updates: { ...s.updates, [id]: info } })),
}));

/** Fetch and cache normalised repo metadata for "owner/repo". No-op without the
 *  native github bridge (plain-browser / older Electron). */
export async function loadRepoMeta(fullName: string): Promise<void> {
  const gh = window.safelightNative?.github;
  if (!gh) return;
  const cur = useExtStoreUI.getState().meta[fullName];
  if (cur && cur.status !== "error") return; // already loading or loaded
  useExtStoreUI.setState((s) => ({
    meta: { ...s.meta, [fullName]: { status: "loading" } },
  }));
  try {
    const data = await gh.repoMeta(fullName);
    useExtStoreUI.setState((s) => ({
      meta: { ...s.meta, [fullName]: { status: "ready", data } },
    }));
  } catch (e) {
    useExtStoreUI.setState((s) => ({
      meta: {
        ...s.meta,
        [fullName]: { status: "error", error: e instanceof Error ? e.message : String(e) },
      },
    }));
  }
}

/** Fetch and cache the README for "owner/repo" at `branch`. */
export async function loadReadme(fullName: string, branch?: string): Promise<void> {
  const gh = window.safelightNative?.github;
  if (!gh) return;
  const cur = useExtStoreUI.getState().readme[fullName];
  if (cur && cur.status !== "error") return;
  useExtStoreUI.setState((s) => ({
    readme: { ...s.readme, [fullName]: { status: "loading" } },
  }));
  try {
    const data = await gh.readme(fullName, branch);
    useExtStoreUI.setState((s) => ({
      readme: { ...s.readme, [fullName]: { status: "ready", data } },
    }));
  } catch (e) {
    useExtStoreUI.setState((s) => ({
      readme: {
        ...s.readme,
        [fullName]: { status: "error", error: e instanceof Error ? e.message : String(e) },
      },
    }));
  }
}
