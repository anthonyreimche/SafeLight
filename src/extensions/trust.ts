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
import { readSources } from "./sources";
import { isNewer } from "@/update/semver";

const EMPTY: TrustList = { verified: [], reviewed: {}, repos: [], owners: [], reason: {} };

// localStorage mirror of the lists (already lowercased by the main process). This
// is what makes the boot ban-check synchronous: the store seeds from it, so
// extensions and themes activate immediately from the cached answer with no fetch
// to await. loadTrustList() refreshes it in the background, on its own schedule.
const LS_KEY = "sl_trust_cache";

function readLsTrust(): TrustList | null {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) ?? "null");
    if (raw && typeof raw === "object" && Array.isArray(raw.verified))
      return {
        verified: raw.verified.map(String),
        reviewed:
          raw.reviewed && typeof raw.reviewed === "object" ? raw.reviewed : {},
        repos: Array.isArray(raw.repos) ? raw.repos.map(String) : [],
        owners: Array.isArray(raw.owners) ? raw.owners.map(String) : [],
        reason: raw.reason && typeof raw.reason === "object" ? raw.reason : {},
      };
  } catch {}
  return null;
}

function writeLsTrust(list: TrustList): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list));
  } catch {}
}

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
  list: readLsTrust() ?? EMPTY, // synchronous seed — boot checks need no fetch
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
      writeLsTrust(list); // mirror for the next launch's synchronous boot check
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

// The main process lowercases the registry before it reaches us; folding the
// stored side again here is depth — one entry that slips through uncased must
// not quietly stop banning.
const listHas = (entries: string[], repo: string): boolean =>
  entries.some((e) => norm(e) === repo);

const entryFor = <T>(map: Record<string, T>, key: string): T | undefined =>
  map[key] ?? Object.entries(map).find(([k]) => norm(k) === key)?.[1];

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

export type VerificationStatus = "unverified" | "verified" | "stale";

// Pure list-taking cores — the plain functions read the current store state, the
// hooks subscribe to it, both go through these so the logic can't drift.

function isVerifiedIn(list: TrustList, repo: string | null | undefined): boolean {
  const r = norm(repo);
  return !!r && listHas(list.verified, r);
}

function reviewedForIn(
  list: TrustList,
  repo: string | null | undefined,
): { version?: string; commit?: string } | null {
  const r = norm(repo);
  return (r && entryFor(list.reviewed, r)) || null;
}

function verificationStatusIn(
  list: TrustList,
  repo: string | null | undefined,
  version?: string | null,
): VerificationStatus {
  if (!isVerifiedIn(list, repo)) return "unverified";
  const rv = reviewedForIn(list, repo)?.version;
  if (rv && version && isNewer(rv, version)) return "stale";
  return "verified";
}

function bannedReasonIn(
  list: TrustList,
  repo: string | null | undefined,
): string | null {
  const r = norm(repo);
  if (!r) return null;
  const owner = ownerOf(r);
  if (listHas(list.repos, r) || listHas(list.owners, owner))
    return (
      entryFor(list.reason, r) || entryFor(list.reason, owner) || "flagged as unsafe"
    );
  return null;
}

/** True when "owner/repo" is on the human-reviewed allowlist. */
export function isVerified(repo: string | null | undefined): boolean {
  return isVerifiedIn(useTrust.getState().list, repo);
}

/** The reviewed point (version/commit) for a pinned verified repo, else null.
 *  Null for legacy bare-string entries (verified, but not pinned to a version). */
export function reviewedFor(
  repo: string | null | undefined,
): { version?: string; commit?: string } | null {
  return reviewedForIn(useTrust.getState().list, repo);
}

/** Verified state of a repo given the version actually in play (installed, or
 *  about to be installed). "stale" = the repo is verified but `version` is newer
 *  than the reviewed version, so the code is past the review point and must be
 *  treated as unreviewed. Unpinned verified entries are always "verified". */
export function verificationStatus(
  repo: string | null | undefined,
  version?: string | null,
): VerificationStatus {
  return verificationStatusIn(useTrust.getState().list, repo, version);
}

/** The ban reason when "owner/repo" — or its whole owner account — is on the
 *  kill-switch, else null. Checks the exact repo and the bare owner. */
export function bannedReason(repo: string | null | undefined): string | null {
  return bannedReasonIn(useTrust.getState().list, repo);
}

/** Convenience boolean form of {@link bannedReason}. */
export function isBanned(repo: string | null | undefined): boolean {
  return bannedReason(repo) !== null;
}

// Reactive hook forms for components — they re-render when the lists load/change.

/** Hook: true when "owner/repo" is on the verified allowlist. */
export function useIsVerified(repo: string | null | undefined): boolean {
  return useTrust((s) => isVerifiedIn(s.list, repo));
}

/** Hook: the reviewed point (version/commit) for a pinned verified repo, else null. */
export function useReviewedFor(
  repo: string | null | undefined,
): { version?: string; commit?: string } | null {
  return useTrust((s) => reviewedForIn(s.list, repo));
}

/** Hook form of {@link verificationStatus}. */
export function useVerificationStatus(
  repo: string | null | undefined,
  version?: string | null,
): VerificationStatus {
  return useTrust((s) => verificationStatusIn(s.list, repo, version));
}

/** Hook: the ban reason for "owner/repo" (or its owner), else null. */
export function useBannedReason(repo: string | null | undefined): string | null {
  return useTrust((s) => bannedReasonIn(s.list, repo));
}

/** The ban reason for an installed extension, resolved through the repo we
 *  actually installed it from. `manifest.repository` ships inside the extension
 *  being judged, so it is only ever consulted as a second opinion: it can add a
 *  ban (an honest self-declaration, or an install we never recorded a source
 *  for) but can never clear the one its install source earns. An extension with
 *  neither reads as unbanned — there is nothing to check it against. */
export function bannedReasonForManifest(m: ExtensionManifest): string | null {
  return bannedReason(readSources()[m.id]) ?? bannedReason(m.repository);
}
