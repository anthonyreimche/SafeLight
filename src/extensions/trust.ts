// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Renderer-side view of the extension trust registry: a verified allowlist (a
// human reviewed the repo) and a banned kill-switch (repos/owners that turned
// malicious — refused at install and skipped at load, even once installed). The
// lists are fetched + normalised in the Electron main process (the renderer CSP
// blocks the raw.githubusercontent fetch); here we cache the one payload and
// expose synchronous isVerified/isBanned lookups so the store UI and loader can
// decide without awaiting per-extension. Mirrors the cache shape of store-ui.ts.

import { create } from "zustand";
import type { ExtensionManifest, TrustList } from "./types";
import { repoFor } from "./sources";

const EMPTY: TrustList = { verified: [], repos: [], owners: [], reason: {} };

/** An installed extension the kill-switch refused to load this session. */
export interface FlaggedExtension {
  id: string;
  name: string;
  reason: string;
}

interface TrustState {
  list: TrustList;
  /** Epoch ms of the last successful load, or 0 if never. */
  loadedAt: number;
  /** Banned extensions skipped at load — surfaced by the security banner. */
  flagged: FlaggedExtension[];
}

export const useTrust = create<TrustState>(() => ({
  list: EMPTY,
  loadedAt: 0,
  flagged: [],
}));

/** Record that a banned installed extension was skipped at load (deduped by id). */
export function flagBannedExtension(f: FlaggedExtension): void {
  useTrust.setState((s) =>
    s.flagged.some((x) => x.id === f.id)
      ? s
      : { flagged: [...s.flagged, f] },
  );
}

/** Dismiss the security banner's notice for one extension. */
export function dismissFlag(id: string): void {
  useTrust.setState((s) => ({ flagged: s.flagged.filter((x) => x.id !== id) }));
}

let inflight: Promise<void> | null = null;

/** Fetch the registry lists once and cache them. No-op without the native
 *  bridge (plain-browser build / older Electron) — everything then reads as
 *  unverified and nothing is banned. Never throws. */
export async function loadTrustList(force = false): Promise<void> {
  const fn = window.safelightNative?.plugins?.trustList;
  if (!fn) return;
  if (!force && useTrust.getState().loadedAt) return;
  if (inflight && !force) return inflight;
  inflight = (async () => {
    try {
      const list = await fn(force);
      useTrust.setState({ list, loadedAt: Date.now() });
    } catch {
      // Keep whatever we had; a registry hiccup must never block the store.
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

const norm = (repo: string | null | undefined): string =>
  (repo ?? "").trim().toLowerCase();

/** Extract the lowercased "owner/repo" from an install spec — "owner/repo",
 *  "owner/repo#branch", or a github.com URL — or null if it's unparseable.
 *  Mirrors the main process's parseRepoSpec for renderer-side trust lookups. */
export function repoFromSpec(spec: string): string | null {
  const s = spec.trim();
  const url = s.match(
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#]+?)(?:\.git)?(?:\/tree\/[^\s]+)?\/?$/i,
  );
  if (url) return norm(`${url[1]}/${url[2]}`);
  const m = s.split("#")[0].match(/^([^/\s]+)\/([^/\s]+)$/);
  return m ? norm(`${m[1]}/${m[2]}`) : null;
}

const ownerOf = (repo: string): string => repo.split("/")[0] ?? "";

/** True when "owner/repo" is on the human-reviewed allowlist. */
export function isVerified(repo: string | null | undefined): boolean {
  const r = norm(repo);
  return !!r && useTrust.getState().list.verified.includes(r);
}

/** The ban reason when "owner/repo" — or its whole owner account — is on the
 *  kill-switch, else null. Checks the exact repo and the bare owner. */
export function bannedReason(repo: string | null | undefined): string | null {
  const r = norm(repo);
  if (!r) return null;
  const { repos, owners, reason } = useTrust.getState().list;
  const owner = ownerOf(r);
  if (repos.includes(r) || owners.includes(owner))
    return reason[r] || reason[owner] || "flagged as unsafe";
  return null;
}

/** Convenience boolean form of {@link bannedReason}. */
export function isBanned(repo: string | null | undefined): boolean {
  return bannedReason(repo) !== null;
}

// Reactive hook forms for components — they re-render when the lists load/change.

/** Hook: true when "owner/repo" is on the verified allowlist. */
export function useIsVerified(repo: string | null | undefined): boolean {
  return useTrust((s) => {
    const r = norm(repo);
    return !!r && s.list.verified.includes(r);
  });
}

/** Hook: the ban reason for "owner/repo" (or its owner), else null. */
export function useBannedReason(repo: string | null | undefined): string | null {
  return useTrust((s) => {
    const r = norm(repo);
    if (!r) return null;
    const owner = ownerOf(r);
    if (s.list.repos.includes(r) || s.list.owners.includes(owner))
      return s.list.reason[r] || s.list.reason[owner] || "flagged as unsafe";
    return null;
  });
}

/** The ban reason for an installed extension, resolved via its source repo. */
export function bannedReasonForManifest(m: ExtensionManifest): string | null {
  return bannedReason(repoFor(m));
}
