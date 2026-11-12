// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Extension store and trust metadata: manifests, registry results, releases.

/** A repo found by the official-extension search (GitHub topic). */
export interface ExtensionSearchResult {
  /** "owner/repo" — also the install spec. */
  fullName: string;
  /** The extension's manifest name, from the registry index. Absent on live
   *  search results, where the store shows the repo name instead. */
  name?: string;
  description: string | null;
  stars: number;
  /** Repo creation time (ISO). Drives the store's "New" shelf. Present from the
   *  prebuilt registry index; null on the live-search fallback for repos GitHub's
   *  search payload didn't carry it for. */
  createdAt?: string | null;
  updatedAt: string;
  /** Where this result came from: the prebuilt registry index ("registry") or a
   *  live GitHub search ("live"). The browse grid skips per-card thumbnail
   *  re-resolution for "registry" results — their thumbnail is already baked by
   *  the index build, so a runtime icon/og round-trip would add nothing. */
  source?: "registry" | "live";
  /** GitHub repo topics — the store's category source when `categories` is absent. */
  topics?: string[];
  /** Store category slugs the registry build resolved. Absent on live-search
   *  results and older indexes, where the store reads the topics instead;
   *  [] means the registry found none (shown under Other). */
  categories?: string[];
  /** Type badge slug from the registry build (module, pipeline, panel), or
   *  null when it found none. */
  type?: string | null;
  /** Search keywords from the extension's manifest. */
  keywords?: string[];
  /** Screenshot URLs (https) from the extension's manifest. */
  screenshots?: string[];
  /** "owner/repo" extensions it pairs well with, linked both ways by the
   *  registry build. */
  worksWith?: string[];
  /** Owner avatar on the direct avatars CDN — the instant fallback thumbnail and
   *  the card's first paint (no github.com/owner.png redirect). */
  avatarUrl?: string | null;
  /** Best store thumbnail resolved in the main process (manifest icon → custom
   *  social preview → avatar). `custom` is false only for the avatar fallback, so
   *  the card can letterbox it instead of filling the frame. Present when served
   *  from a warm cache; the grid refreshes it via github.thumbnails on open. */
  thumbnail?: ExtensionThumbnail | null;
}

/** A resolved browse-card thumbnail. `custom` distinguishes a purpose-made
 *  icon/social-preview (fills the card) from the avatar fallback (letterboxed). */
export interface ExtensionThumbnail {
  url: string;
  custom: boolean;
}

/** One Extensions-store category, as registry.json publishes it. */
export interface StoreCategory {
  slug: string;
  label: string;
  description: string;
}

/** A type badge: what an extension adds (Module, Processing, Panel). */
export interface StoreType {
  slug: string;
  label: string;
}

/** The store's categories in display order and type badges in precedence order. */
export interface StoreVocabulary {
  categories: StoreCategory[];
  types: StoreType[];
}

/** Curation lists from the trust registry repo, fetched + normalized (lowercased)
 *  in the Electron main process. `verified` is the human-reviewed allowlist;
 *  `repos`/`owners` are the banned kill-switch; `reason` maps a banned
 *  "owner/repo" or "owner" to a short explanation shown to the user. */
export interface TrustList {
  verified: string[];
  /** For pinned verified entries, the reviewed point per "owner/repo": the
   *  version (and/or commit) a maintainer actually reviewed. Absent for legacy
   *  bare-string entries (verification not pinned to a version). A repo whose
   *  current version is newer than the reviewed version is "stale-verified" — the
   *  code in play is past the review, so the badge/install treat it as unreviewed. */
  reviewed: Record<string, { version?: string; commit?: string }>;
  repos: string[];
  owners: string[];
  reason: Record<string, string>;
}

/** Normalized GitHub repo metadata for the Extensions store detail view.
 *  A subset of the GitHub repos API, shaped in the Electron main process. */
export interface ExtensionRepoMeta {
  fullName: string;
  description: string | null;
  stars: number;
  openIssues: number;
  updatedAt: string;
  license: string | null;
  topics: string[];
  homepage: string | null;
  htmlUrl: string;
  /** Branch to fetch the README and resolve relative asset links against. */
  defaultBranch: string;
  ownerLogin: string;
  ownerAvatarUrl: string | null;
  hasIssues: boolean;
  hasDiscussions: boolean;
  /** GitHub's social-preview card — a usable thumbnail with no manifest icon. */
  ogImageUrl: string;
}

/** safelight.json at the root of an extension repo. All fields beyond the core
 *  five (id/name/version/main) are optional and additive — older manifests load
 *  unchanged; the store simply shows richer detail when they're present. */
export interface ExtensionManifest {
  /** A letter or digit, then letters, digits, `.`, `_` and `-`. `core` and anything
   *  under `core.`, in any case, belong to Safelight's built-ins and are refused. */
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  /** Entry ESM bundle, relative to the extension folder, e.g. "dist/index.js". */
  main: string;
  /** Icon URL (absolute, or relative to the repo's default branch). */
  icon?: string;
  /** Store categories, e.g. ["Panels", "Colour"]. Preferred over repo topics. */
  categories?: string[];
  /** Free-form search keywords. */
  keywords?: string[];
  /** Project homepage / docs URL. */
  homepage?: string;
  /** Source repo as "owner/repo" — lets a custom-imported extension self-declare
   *  its repo so the detail view can show its README without a remembered source. */
  repository?: string;
  /** Screenshot URLs (absolute, or relative to the repo's default branch). */
  screenshots?: string[];
  /** "owner/repo" extensions this one pairs well with. The store lists them on
   *  this extension's page, and this one on theirs when it is verified. */
  worksWith?: string[];
  /** SPDX license id, e.g. "MIT". */
  license?: string;
  /** Minimum SafeLight version required, e.g. "1.2.0". Blocks install below it. */
  minAppVersion?: string;
  /** Capabilities the extension requests (shown to the user in the store). Only
   *  `network` is *enforced* — declared HTTPS origins are added to the app's
   *  content-security policy, and anything not declared by an installed or
   *  dev-folder extension is blocked. Extensions otherwise run in-app with
   *  ambient access (your catalogue, files); that is NOT confined by this field,
   *  so install only extensions you trust. See EXTENSIONS.md. */
  permissions?: ExtensionPermissions;
}

/** The update-relevant fields of the safelight.json a repo currently publishes. */
export interface RemoteManifest {
  version: string;
  minAppVersion?: string;
}

/** One GitHub release of an extension. Lists are newest version first. */
export interface ExtensionRelease {
  version: string;
  tag: string;
  prerelease: boolean;
  /** ISO date, or "" when GitHub gave none. */
  publishedAt: string;
  /** Release notes as Markdown, capped at 20 KB. */
  notes: string;
  htmlUrl: string;
}

/** Declared extension capabilities. See ExtensionManifest.permissions. */
export interface ExtensionPermissions {
  /** HTTPS origins the extension needs to reach, e.g. ["https://api.example.com"]
   *  (a single leading-label wildcard like "https://*.example.com" is allowed).
   *  Only declared origins pass the content-security policy; undeclared hosts are
   *  blocked. A new declaration takes effect after the next app launch. */
  network?: string[];
  /** The extension connects to a server address the person types in (api.network),
   *  which no manifest can name ahead of time. Each address is allowed by the
   *  person in a dialogue naming the extension before any request reaches it.
   *  Needs Safelight 3.2.4. */
  userOrigins?: boolean;
  /** Optional human-readable rationale shown to the user beside the request. */
  reason?: string;
}
