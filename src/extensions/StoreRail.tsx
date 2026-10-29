// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Extensions store's left rail: Updates, Browse, Installed and Dev, with
// the registry's categories listed under Browse on request. The list starts
// hidden; the chevron only shows or hides it, while the Browse label opens the
// home page and shows it, so a category is always one click away.

import { useContext } from "react";
import { useExtStoreUI } from "./store-ui";
import { OTHER } from "./store-categories";
import { StoreExpanded } from "./StoreCards";

export type StoreSection = "Updates" | "Browse" | "Installed" | "Dev";

const CATEGORY_LIST_ID = "store-rail-categories";

const rowText = (active: boolean) =>
  active ? "text-text-primary" : "text-text-secondary hover:text-text-primary";

export function StoreRail({
  sections,
  section,
  onSection,
  badges = {},
  categories,
  showOther,
}: {
  sections: StoreSection[];
  section: StoreSection;
  onSection: (s: StoreSection) => void;
  badges?: Partial<Record<StoreSection, number>>;
  /** List the categories under Browse (Browse needs the desktop bridge). */
  categories: boolean;
  /** Something not installed has no category, so Other has members. */
  showOther: boolean;
}) {
  const browse = useExtStoreUI((s) => s.browse);
  const wide = useContext(StoreExpanded);
  const expanded = useExtStoreUI((s) => s.railExpanded);
  const vocabulary = useExtStoreUI((s) => s.vocabulary);
  const onBrowse = section === "Browse";
  const listed = categories && expanded;
  const browseActive = onBrowse && (browse === "home" || !listed);

  const open = (key: string) => {
    onSection("Browse");
    useExtStoreUI.getState().openCategory(key);
  };
  const categoryRow = (slug: string, label: string) => {
    const active = onBrowse && browse === slug;
    return (
      <li key={slug}>
        <button
          onClick={() => open(slug)}
          title={label}
          aria-current={active ? "page" : undefined}
          className={`flex w-full py-1 pl-5 pr-3 text-left text-[11px] tracking-wider ${
            active ? "bg-surface-3" : ""
          } ${rowText(active)}`}
        >
          <span className="truncate">{label}</span>
        </button>
      </li>
    );
  };

  return (
    <nav
      aria-label="Extensions"
      className={`${wide ? "w-48" : "w-36"} shrink-0 overflow-y-auto border-r border-border bg-surface-0/40 py-2`}
    >
      {sections.map((s) =>
        s === "Browse" ? (
          <div key={s}>
            <div className={`flex items-center ${browseActive ? "bg-surface-3" : ""}`}>
              <button
                onClick={() => {
                  onSection("Browse");
                  useExtStoreUI.getState().goHome();
                }}
                aria-current={browseActive ? "page" : undefined}
                className={`min-w-0 flex-1 px-3 py-1.5 text-left text-[11px] tracking-wider ${rowText(browseActive)}`}
              >
                Browse
              </button>
              {categories && (
                <button
                  onClick={() => useExtStoreUI.getState().toggleRail()}
                  aria-expanded={expanded}
                  aria-controls={CATEGORY_LIST_ID}
                  aria-label={expanded ? "Hide categories" : "Show categories"}
                  className="px-2 py-1.5 text-[10px] text-text-muted hover:text-text-primary"
                >
                  {expanded ? "▾" : "▸"}
                </button>
              )}
            </div>
            {categories && (
              <ul id={CATEGORY_LIST_ID} aria-label="Categories" hidden={!listed}>
                {listed && vocabulary.categories.map((c) => categoryRow(c.slug, c.label))}
                {listed && showOther && categoryRow(OTHER.slug, OTHER.label)}
              </ul>
            )}
          </div>
        ) : (
          <button
            key={s}
            onClick={() => onSection(s)}
            aria-current={section === s ? "page" : undefined}
            className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] tracking-wider ${
              section === s ? "bg-surface-3" : ""
            } ${rowText(section === s)}`}
          >
            <span>{s}</span>
            {(badges[s] ?? 0) > 0 && (
              <span className="rounded-full bg-slider-fill px-1.5 text-[9px] font-medium leading-[14px] text-white">
                {badges[s]}
              </span>
            )}
          </button>
        ),
      )}
    </nav>
  );
}
