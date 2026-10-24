// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Extensions store's browse cards: a shelf (one labelled, sideways-
// scrolling row), the preview card itself, and the small section label. Shared
// by the Browse pages and the detail page's related shelves.

import { useEffect, useRef, useState } from "react";
import type { ExtensionSearchResult, ExtensionThumbnail, StoreVocabulary } from "./types";
import { reducedMotion } from "@/ui/reduced-motion";
import { useBannedReason, useIsVerified } from "./trust";
import { FlaggedBadge, VerifiedBadge } from "./TrustBadges";
import { useExtStoreUI } from "./store-ui";
import { categoriesOf, typeOf } from "./store-categories";

/** How many cards a shelf shows. */
export const SHELF_LIMIT = 12;

/** "{first category} · {type}", either part left out when absent. */
export function cardTag(result: ExtensionSearchResult, vocab: StoreVocabulary): string {
  return [categoriesOf(result, vocab)[0]?.label, typeOf(result, vocab)?.label]
    .filter((part): part is string => !!part)
    .join(" · ");
}

// One App-Store-style "shelf": a labelled, horizontally-scrolling row of cards
// (Featured / New / Popular / Recently updated). Each card keeps a fixed width so
// the row scrolls sideways instead of wrapping. Reuses ExtensionCard, so install /
// open / thumbnail behaviour matches the flat grid exactly.
export function Shelf({
  title,
  items,
  thumbs,
  busy,
  onOpen,
  onInstall,
  isInstalled,
}: {
  title: string;
  items: ExtensionSearchResult[];
  thumbs: Record<string, ExtensionThumbnail>;
  busy: string | null;
  onOpen: (repo: string) => void;
  onInstall: (repo: string, r: ExtensionSearchResult) => void;
  /** Cards of installed extensions show "Installed" in place of Install. */
  isInstalled?: (r: ExtensionSearchResult) => boolean;
}) {
  return (
    <div>
      <SectionLabel>{title}</SectionLabel>
      <div className="mt-1 flex gap-2 overflow-x-auto pb-1">
        {items.map((r, i) => (
          <div key={r.fullName} className="w-44 shrink-0">
            <ExtensionCard
              index={i}
              result={r}
              thumb={thumbs[r.fullName] ?? r.thumbnail ?? null}
              installing={busy === r.fullName}
              installed={isInstalled?.(r) ?? false}
              disabled={busy !== null}
              onOpen={() => onOpen(r.fullName)}
              onInstall={() => void onInstall(r.fullName, r)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// A browse-result preview card: repo thumbnail, name, description, stars, and its
// category · type tag. Clicking the body opens the detail page; Install stays inline.
export function ExtensionCard({
  index,
  result,
  thumb,
  installing,
  installed = false,
  disabled,
  onOpen,
  onInstall,
}: {
  index: number;
  result: ExtensionSearchResult;
  /** Resolved thumbnail (icon / social preview / avatar). Null until the parent's
   *  batched resolution lands — we then fall back to the owner avatar. */
  thumb: ExtensionThumbnail | null;
  installing: boolean;
  /** Already installed: shows "Installed" in place of the Install button. */
  installed?: boolean;
  disabled: boolean;
  onOpen: () => void;
  onInstall: () => void;
}) {
  const vocabulary = useExtStoreUI((s) => s.vocabulary);
  const tag = cardTag(result, vocabulary);
  const short = result.fullName.split("/")[1] ?? result.fullName;
  const verified = useIsVerified(result.fullName);
  const banned = useBannedReason(result.fullName);
  const cardRef = useRef<HTMLDivElement>(null);
  const owner = result.fullName.split("/")[0];
  const avatar = result.avatarUrl ?? `https://github.com/${owner}.png?size=120`;
  // Thumbnails are resolved once, batched, in the main process (manifest icon →
  // custom social preview → avatar) and cached, so the per-card iconUrl waterfall
  // that used to gate the grid is gone. Until that resolution lands we paint the
  // avatar (or whatever warm-cache thumbnail the search result carried). `custom`
  // is false only for the avatar fallback, so it sits contained/centred while a
  // deliberate icon/preview (sized for the card) fills the frame.
  const resolved: ExtensionThumbnail = thumb ?? { url: avatar, custom: false };

  // The card paints the owner avatar instantly as an always-present base layer,
  // then overlays the resolved custom icon/preview ONLY once it has actually
  // loaded. This guarantees the card is never blank: a slow, hung, or failed
  // preview simply leaves the avatar showing instead of a grey frame (the bug
  // where re-opening the store showed empty cards, and the 17s "nothing then
  // everything" on first open). `showCustom` is the resolved thumbnail being a
  // real icon/preview (not the avatar fallback); it's cleared if that image
  // errors, so we fall back to the avatar.
  const [showCustom, setShowCustom] = useState(resolved.custom);
  const [customLoaded, setCustomLoaded] = useState(false);
  useEffect(() => {
    setShowCustom(resolved.custom);
    setCustomLoaded(false);
  }, [resolved.url, resolved.custom]);

  // Cascade the cards in instead of popping the whole grid at once: each card
  // fades/rises in, staggered by its position (capped so a full page of 25 still
  // finishes quickly). `fill: backwards` holds it hidden until its turn. Honour
  // reduced-motion (the app setting or the OS) by leaving the card at its natural
  // (visible) style.
  useEffect(() => {
    const el = cardRef.current;
    if (
      !el ||
      reducedMotion() ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const anim = el.animate(
      [
        { opacity: 0, transform: "translateY(6px)" },
        { opacity: 1, transform: "none" },
      ],
      {
        duration: 240,
        delay: Math.min(index * 35, 420),
        easing: "ease-out",
        fill: "backwards",
      },
    );
    return () => anim.cancel();
    // Mount-only: index is the position at first paint; re-filtering remounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={cardRef}
      className="flex flex-col overflow-hidden rounded border border-border-subtle bg-surface-2 text-[11px]"
    >
      <button onClick={onOpen} className="block text-left">
        <div className="relative aspect-[2/1] w-full overflow-hidden bg-surface-3">
          {/* Always-present base: the owner avatar, contained + padded. Paints
              instantly so the card is never blank while a preview resolves. */}
          <img
            src={avatar}
            alt=""
            aria-hidden
            referrerPolicy="no-referrer"
            className="absolute inset-0 h-full w-full"
            style={{ objectFit: "contain", padding: "0.75rem" }}
            onError={(e) => (e.currentTarget.style.visibility = "hidden")}
          />
          {/* Upgrade overlay: a custom icon/social preview, faded in only once it
              has actually loaded (so it never replaces the avatar with a blank
              frame). On error we drop it and the avatar shows through. */}
          {showCustom && (
            <img
              src={resolved.url}
              alt=""
              referrerPolicy="no-referrer"
              className="absolute inset-0 h-full w-full"
              style={{
                objectFit: "cover",
                opacity: customLoaded ? 1 : 0,
                transition: "opacity 200ms ease-out",
              }}
              onLoad={() => setCustomLoaded(true)}
              onError={() => setShowCustom(false)}
            />
          )}
        </div>
        <div className="p-2">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 truncate font-medium text-text-primary">
              {short}
            </span>
            {verified && <VerifiedBadge iconOnly />}
            <div className="flex-1" />
            {result.stars > 0 && (
              <span className="shrink-0 text-text-muted">★ {result.stars}</span>
            )}
          </div>
          {result.description && (
            <div className="mt-0.5 line-clamp-2 text-text-muted">
              {result.description}
            </div>
          )}
        </div>
      </button>
      <div className="mt-auto flex items-center justify-between gap-2 px-2 pb-2">
        {tag ? (
          <span
            title={tag}
            className="min-w-0 truncate rounded-full bg-surface-3 px-1.5 py-0.5 text-[9px] text-text-muted"
          >
            {tag}
          </span>
        ) : (
          <span />
        )}
        {banned ? (
          <FlaggedBadge reason={banned} />
        ) : installed ? (
          <span className="shrink-0 text-text-muted">Installed</span>
        ) : (
          <button
            disabled={disabled}
            onClick={onInstall}
            className="shrink-0 rounded bg-slider-fill px-2 py-0.5 font-medium text-white hover:opacity-80 disabled:opacity-40"
          >
            {installing ? "…" : "Install"}
          </button>
        )}
      </div>
    </div>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[9px] uppercase tracking-widest text-text-muted">
      {children}
    </div>
  );
}
