// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { SafelightAPI } from "./scoped-api";
import type { NativeOpenTarget } from "./stores";
import type {
  ExtensionManifest,
  ExtensionRelease,
  ExtensionRepoMeta,
  ExtensionSearchResult,
  ExtensionThumbnail,
  RemoteManifest,
  StoreVocabulary,
  TrustList,
} from "./store-types";

export type { NativeOpenTarget } from "./stores";

/** One "separate" catalogue folder, as listed by the Preferences manager. */
export interface ExternalCatalogEntry {
  /** The per-source folder on disk — the reveal / delete target. */
  path: string;
  /** Folder leaf, e.g. "DCIM-1a2b3c4d" (source-name slug + path hash). */
  name: string;
  /** The source folder this catalogue was created for, or null if unrecorded
   *  (catalogues created before source.json was written). */
  sourcePath: string | null;
  /** Creation time (ms since epoch), or null if unrecorded. */
  createdAt: number | null;
  /** Total size on disk in bytes (catalogue + previews + RAW cache). */
  bytes: number;
  /** Last-modified time of the folder (ms since epoch), 0 if unknown. */
  mtimeMs: number;
  /** What the source held when the catalogue was last opened, to tell apart the
   *  catalogues of cards mounted at one path: how many photos, when, and the
   *  names of a few. Null / empty when unrecorded. */
  photoCount?: number | null;
  lastOpenedAt?: number | null;
  sampleNames?: string[];
}

/** Raw filesystem access by absolute path. Privileged: handed to core exactly
 *  once at boot via claimPrivileged() and never left on the page global, because
 *  extension code shares the renderer realm and could otherwise read/write/delete
 *  any file. Backs the path-based handle adapters (src/project/native-fs.ts). */
export interface NativeFsBridge {
  /** Read a file. With `range`, only bytes [start, end) are read, clipped to the
   *  file's end; `size` is always the whole file's. */
  read(
    path: string,
    range?: { start: number; end: number },
  ): Promise<{ data: Uint8Array; mtimeMs: number; size: number }>;
  write(path: string, data: Uint8Array): Promise<void>;
  /** A folder's entries. A link is listed as what it points to, and a broken one
   *  as a folder whose own listing fails; a folder link back above `path`, or into
   *  the project folder `root` when given, is left out. With `withSizes`, `size` is
   *  a file's size in bytes, when it could be read; without it the files aren't
   *  stat'ed, which saves a round trip each on a network share. */
  list(
    path: string,
    root?: string,
    withSizes?: boolean,
  ): Promise<{ name: string; kind: "file" | "directory"; size?: number }[]>;
  mkdir(path: string): Promise<void>;
  /** Resolve a separate .safelight working directory for a project folder, under
   *  `baseOverride` or the app's data dir, keyed by the source path so each folder
   *  keeps its own catalogue. With `create` (default true) the directory is created
   *  and its path returned; with `create === false` it's an existence probe that
   *  returns the path only if a catalogue already lives there, else null. `variant`
   *  (default 1) picks the source's further catalogues, for another card mounted at
   *  the same path. Absent on older Electron builds — callers must feature-detect. */
  externalCatalogDir?(
    rootPath: string,
    baseOverride?: string | null,
    create?: boolean,
    variant?: number,
  ): Promise<string | null>;
  /** The `variant`s of a project folder's separate catalogues under `baseOverride`
   *  (or the app data dir) that hold a catalogue, ascending. Absent on older
   *  Electron builds — feature-detect. */
  externalCatalogVariants?(rootPath: string, baseOverride?: string | null): Promise<number[]>;
  /** The .safelight working directory of a library source's catalogue under the
   *  app's data dir, made if missing: one per `key` (the source and the library
   *  it shows), its folder named after `name`. Absent on older Electron builds —
   *  feature-detect. */
  sourceCatalogDir?(key: string, name: string): Promise<string>;
  /** List the "separate" catalogues stored under `baseOverride` (or the app data
   *  dir) for the Preferences manager. Each entry's `path` is the per-source
   *  folder to reveal or delete. Absent on older Electron builds — feature-detect. */
  listExternalCatalogs?(baseOverride?: string | null): Promise<ExternalCatalogEntry[]>;
  /** Spillover pointer: record / look up / clear which separate catalogue a
   *  read-only source spilled into. Stored under the app-data default (not the
   *  configured base), so a later writeable open can fold the spillover back no
   *  matter which "Separate catalogue location" is set then. Absent on older
   *  Electron builds — feature-detect. */
  setSpilloverPointer?(rootPath: string, spilloverDir: string): Promise<void>;
  getSpilloverPointer?(rootPath: string): Promise<string | null>;
  clearSpilloverPointer?(rootPath: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Move a path to the OS trash (Recycle Bin) instead of deleting it outright.
   *  Absent on older Electron builds — callers must feature-detect. */
  trash?(path: string): Promise<void>;
  move(src: string, dest: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  pickDirectory(): Promise<string | null>;
  /** Ask for a folder in the OS dialogue (at the one `replacing` names, when
   *  it is extension `id`'s) and keep it for that extension across launches
   *  (electron/kept-folders.cjs); null when cancelled. Absent on older
   *  Electron builds — feature-detect, as for the two below. */
  pickKeptFolder?(id: string, replacing: string | null): Promise<{ token: string; path: string } | null>;
  /** The folder `token` names for extension `id`, or why it can't be used.
   *  "unwritable" is not found for a Windows folder whose permissions refuse
   *  writes (nothing is written to check). Rejects when the record of kept
   *  folders can't be read just now. */
  keptFolder?(id: string, token: string): Promise<{ path: string } | { error: "unknown" | "gone" | "unwritable" }>;
  forgetKeptFolder?(id: string, token: string): Promise<void>;
  /** Pick one file with the OS dialogue; null when cancelled. Absent on older
   *  Electron builds — feature-detect. */
  pickFile?(filters?: { name: string; extensions: string[] }[]): Promise<string | null>;
  /** Reveal a path in the OS file manager — open a directory, or select a file
   *  inside its parent folder. Resolves true on success. */
  reveal(path: string): Promise<boolean>;
}

/** In-app updater. Privileged: install() fetches and runs a release installer
 *  (arbitrary code execution), so it's claimed at boot rather than exposed. */
export interface NativeUpdatesBridge {
  /** Download and install the asset for `tag` from Safelight's own repo (any
   *  other `repo` is refused), quitting once an installer has started. */
  install(repo: string, tag: string): Promise<void>;
  /** What this copy can offer for a release with these asset names: install
   *  it, or its release page (no asset for this platform, or a copy that
   *  can't install itself: macOS, AppImage, Flatpak, Nix, Arch, a non-package
   *  Linux install). Optional: absent in older Electron builds. */
  support?(assetNames: string[]): Promise<UpdateSupport>;
}

export type UpdateSupport = "install" | "release-page";

/** Window capture for the Report an issue dialogue. Privileged so extensions
 *  can't take silent captures of the whole window. */
export interface NativeCaptureBridge {
  /** The sender window as PNG bytes, long edge at most 1920 px; null when the
   *  window can't be captured (minimized, some Wayland setups). */
  page(): Promise<Uint8Array<ArrayBuffer> | null>;
}

/** A child or renderer process the main process saw die this launch. */
export interface NativeCrashRecord {
  time: number;
  /** Electron's process type ("GPU", "Utility", …) or "renderer". */
  process: string;
  reason: string;
  exitCode: number;
  /** Utility process service name, when Electron gives one. */
  name?: string;
}

/** How Safelight draws. The graphics backend is picked before the window
 *  exists, so a change applies at the next start. */
export interface NativeGpuBackendState {
  /** This launch draws in software (SwiftShader) instead of on the graphics card. */
  software: boolean;
  /** The next launch will draw in software. */
  nextSoftware: boolean;
  /** Why the next launch draws in software: the user picked it ("chosen"),
   *  or the graphics card failed. Null when it uses the graphics card. */
  reason: "chosen" | "webgl2-unavailable" | "gpu-crashes" | "renderer-failed" | null;
  /** The ANGLE backend this launch draws with ("gl", "d3d11", "swiftshader", …). */
  backend: string;
  /** The backend the next launch starts on. */
  next: string;
  /** The backend the user picked, or null for Automatic. */
  choice: string | null;
  /** This platform's backends, in the order Automatic tries them. */
  backends: string[];
}

/** Preferences ▸ Rendering ▸ Graphics backend. Privileged so extensions
 *  can't change how every later launch draws. */
export interface NativeGpuBridge {
  /** Null when the main process reports no backend (a build without the GPU ladder). */
  backend(): Promise<NativeGpuBackendState | null>;
  setSoftware(on: boolean): Promise<NativeGpuBackendState | null>;
  /** Pins one of `backends` for later launches; null goes back to Automatic. */
  setBackend(choice: string | null): Promise<NativeGpuBackendState | null>;
  /** The develop renderer couldn't start on this launch's graphics backend
   *  however often it tried: the next launch draws in software. */
  rendererFailed(detail: string): Promise<NativeGpuBackendState | null>;
}

/** The window's system-drawn backdrop. Privileged so extensions can't change
 *  how the window paints; a theme asks for it through the core. */
export interface NativeWindowBridge {
  /** Resolves true when the window now draws the material; null clears it.
   *  False on a system or backend that can't draw it. */
  setMaterial(material: "acrylic" | "mica" | null): Promise<boolean>;
  /** Opens the pop-out, or brings it forward when it is open already. The main
   *  process opens it: a page that opened it itself would hold its object. */
  openApp(kind: "module", module: string): Promise<void>;
  openApp(kind: "devtools"): Promise<void>;
  closeApp(kind: "module", module: string): Promise<void>;
  closeApp(kind: "devtools"): Promise<void>;
  /** Brings the main window forward, from a pop-out. */
  focusMain(): Promise<void>;
}

/** The Developer Tools dev folder. Privileged because the folder's manifests
 *  widen the next launch's network policy. */
export interface NativeDevtoolsBridge {
  /** Record the folder (an absolute path, or null for none) with the main
   *  process, which reads its manifests' `permissions.network` at the next
   *  launch the way it reads installed extensions'. Resolves with the declared
   *  origins the current launch's policy does not allow yet. */
  syncDevFolder(folder: string | null): Promise<{ pending: string[] }>;
}

/** Opening what the OS hands the app. Privileged so extensions can't point the
 *  project at a folder of their choosing. */
export interface NativeOsOpenBridge {
  /** The target waiting to be opened, which it then no longer is; null when none. */
  take(): Promise<NativeOpenTarget | null>;
  /** Called when the OS asks for a target while the app runs; `take()` fetches
   *  it. Returns the unsubscribe. */
  onRequest(listener: () => void): () => void;
}

/** Putting extension code on disk and taking it off again. Privileged so one
 *  extension can't install, replace or remove another. */
export interface NativePluginsBridge {
  /** Accepts "owner/repo", "owner/repo#ref", or a github.com URL. With a
   *  `version`, installs that GitHub release instead of the latest. */
  install(spec: string, version?: string): Promise<ExtensionManifest>;
  uninstall(id: string): Promise<void>;
  /** Finish an install/update: "keep" drops the previous version that
   *  install() kept aside; "rollback" puts it back and returns its manifest
   *  (null when there was none — the install is then removed). */
  settleUpdate(
    id: string,
    outcome: "keep" | "rollback",
  ): Promise<ExtensionManifest | null>;
}

/** What a request through NativeNetBridge.fetch came back with. */
export type NativeNetResult =
  | { status: number; statusText: string; headers: [string, string][]; body: Uint8Array<ArrayBuffer> }
  | { error: { kind: "refused" | "timeout" | "aborted" | "too-large" | "network"; message: string } };

/** Server addresses the person allowed an extension to reach (api.network).
 *  Privileged so core, not the page, names the asking extension. */
export interface NativeNetBridge {
  /** Ask the person, unless already allowed, whether extension `id` may reach
   *  the address of `url`; resolves with whether it may. */
  requestOrigin(id: string, url: string): Promise<boolean>;
  hasOrigin(id: string, url: string): Promise<boolean>;
  revokeOrigin(id: string, url: string): Promise<void>;
  fetch(
    id: string,
    requestId: string,
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; timeoutMs?: number },
  ): Promise<NativeNetResult>;
  abort(requestId: string): Promise<void>;
}

/** The one-shot privileged bundle returned by claimPrivileged(). */
export interface PrivilegedBridge {
  fs: NativeFsBridge;
  updates: NativeUpdatesBridge;
  /** Optional: absent in older Electron builds. */
  plugins?: NativePluginsBridge;
  /** Optional: absent in older Electron builds. */
  capture?: NativeCaptureBridge;
  /** Optional: absent in older Electron builds. */
  gpu?: NativeGpuBridge;
  /** Optional: absent in older Electron builds. */
  osOpen?: NativeOsOpenBridge;
  /** Optional: absent in older Electron builds. */
  window?: NativeWindowBridge;
  /** Optional: absent in older Electron builds. */
  devtools?: NativeDevtoolsBridge;
  /** Optional: absent in older Electron builds. */
  net?: NativeNetBridge;
}

declare global {
  interface Window {
    /** Extension API (also handy in the devtools console). */
    safelight?: SafelightAPI;
    /** Electron bridge; absent in the plain-browser dev build. */
    safelightNative?: {
      platform: string;
      versions: { electron: string; chrome: string };
      /** CPU architecture and OS version (`process.getSystemVersion()`).
       *  Optional: absent in older Electron builds. */
      system?: { arch: string; osVersion: string };
      /** Returns the live version string from package.json (bypasses the Vite build-time constant). */
      appVersion(): Promise<string>;
      /** GitHub Releases API proxy — runs in the main process to bypass the renderer CSP. */
      releases: {
        /** Fetch releases for `owner/repo`. Returns the raw GitHub API array. */
        fetch(repo: string): Promise<{ tag_name: string; html_url: string; body: string | null; draft: boolean }[]>;
      };
      /** GitHub repo metadata + README proxy for the Extensions store detail view.
       *  Optional: absent in the plain-browser build and older Electron builds. */
      github?: {
        /** Normalized repo metadata for "owner/repo". */
        repoMeta(repo: string): Promise<ExtensionRepoMeta>;
        /** Raw README text for "owner/repo" at `ref`, or null if none exists. */
        readme(repo: string, ref?: string): Promise<string | null>;
        /** Batch-resolve the best thumbnail for each browse card (manifest icon →
         *  custom social preview → avatar), in parallel in the main process.
         *  Returns a { "owner/repo": { url, custom } } map; never rejects. */
        thumbnails(
          items: { repo: string; avatar: string | null }[],
          /** Bypass the icon/og caches (the store's ↻) so a just-changed icon or
           *  social preview is re-resolved instead of served stale. */
          force?: boolean,
        ): Promise<Record<string, ExtensionThumbnail>>;
        /** Subscribe to per-repo thumbnails pushed as each resolves (so the grid
         *  upgrades cards progressively rather than all at once). Returns an
         *  unsubscribe fn. */
        onThumbnail(
          cb: (payload: { repo: string; thumb: ExtensionThumbnail }) => void,
        ): () => void;
      };
      plugins: {
        list(): Promise<ExtensionManifest[]>;
        /** Browse official extensions. For the default topic this serves the
         *  prebuilt registry index (one CDN fetch, whole catalogue, baked
         *  thumbnails); a custom topic — or an unreachable index — falls back to a
         *  live GitHub Search. Cached; pass `force` to bypass the cache. */
        search(
          query: string,
          topic: string,
          force?: boolean,
        ): Promise<ExtensionSearchResult[]>;
        /** The newest version a repo publishes, with its minAppVersion, or
         *  null: its newest GitHub release (a newer pre-release with
         *  `prerelease`), or its default branch's safelight.json when it has no
         *  releases. Read from the registry index when that lists the repo.
         *  Optional: absent in older Electron builds. */
        remoteManifest?(
          repo: string,
          opts?: { prerelease?: boolean },
        ): Promise<RemoteManifest | null>;
        /** The repo's releases, newest first; [] for a repo that publishes from
         *  its branch. Rejects when GitHub can't be read. Optional: absent in
         *  older Electron builds. */
        releases?(repo: string, force?: boolean): Promise<ExtensionRelease[]>;
        /** safelight.json at one release's tag, or null. Optional: absent in
         *  older Electron builds. */
        manifestAt?(repo: string, version: string): Promise<RemoteManifest | null>;
        /** Verified-allowlist + banned-kill-switch lists from the trust
         *  registry, cached in the main process. Optional: absent in older
         *  Electron builds (callers then treat everything as unverified). */
        trustList?(force?: boolean): Promise<TrustList>;
        /** The welcome setup's starter kits (kits.json in the trust registry),
         *  cached in the main process; null when it was never fetched. Typed
         *  unknown because it is remote data: parseKits validates it before
         *  anything reads it. Optional: absent in older Electron builds. */
        kits?(force?: boolean): Promise<unknown>;
        /** The store's category vocabulary from the registry index, or null
         *  when the index or its vocabulary is unavailable. Optional: absent in
         *  older Electron builds. */
        vocabulary?(): Promise<StoreVocabulary | null>;
      };
      /** Renderer-side control of the window's Chrome DevTools. Backs the
       *  Developer Tools extension's Native tab. */
      devtools?: {
        open(mode?: "right" | "bottom" | "undocked" | "detach"): Promise<void>;
        close(): Promise<void>;
        toggle(): Promise<void>;
        isOpen(): Promise<boolean>;
        /** Reload the renderer. `hard` ignores the HTTP cache. */
        reload(hard?: boolean): Promise<void>;
      };
      /** Main-process diagnostics for the Developer Tools System / Native tabs. */
      diagnostics?: {
        /** chromium GPU feature status (app.getGPUFeatureStatus()). */
        gpuInfo(): Promise<Record<string, string>>;
        /** Per-process CPU / memory metrics (app.getAppMetrics()). */
        metrics(): Promise<
          {
            type: string;
            pid: number;
            cpuPercent: number;
            memoryMB: number;
          }[]
        >;
        /** Processes that died this launch, oldest first. Optional: absent
         *  in older Electron builds. */
        crashes?(): Promise<NativeCrashRecord[]>;
      };
      /** Opens a prefilled Safelight new-issue page in the system browser.
       *  Links too long for the OS hand-off travel through a one-shot local
       *  redirect. Rejects for any other URL. Optional: absent in older
       *  Electron builds. */
      report?: {
        openIssue(url: string): Promise<void>;
      };
      /** Recolor the native window-controls overlay (Windows/Linux) to follow
       *  the active theme and size to the Interface scale; on macOS it only
       *  re-centres the traffic lights. */
      titlebar?: {
        setOverlay(color: string, symbolColor: string, uiScale?: number): Promise<void>;
      };
      /** One-shot handover of the privileged fs + update-installer surface.
       *  Returns the bundle on the first call (core, at boot) and null after, so
       *  extension code — which shares the renderer realm — can never acquire it.
       *  Optional: absent in the plain-browser build and older Electron builds. */
      claimPrivileged?(): PrivilegedBridge | null;
    };
  }
}
