// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Extensions store, extension install lifecycle and the in-app updater.
// Reading the store is public; installing, uninstalling and settling an
// extension, and installing a Safelight release, are privileged.

const { selfInstallMethod, updateSupport } = require("../self-update.cjs");

/**
 * @param {{
 *   store: {
 *     fetchReleases(repo: string): Promise<unknown>,
 *     fetchRepoMeta(repo: string): Promise<unknown>,
 *     resolveThumbnails(items: unknown, onEach: (repo: string, thumb: unknown) => void, force: boolean): Promise<unknown>,
 *     fetchReadme(repo: string, ref: string): Promise<string | null>,
 *     installPlugin(spec: unknown, version: string | undefined): Promise<unknown>,
 *     searchExtensions(query: unknown, topic: unknown, force: unknown): Promise<unknown>,
 *     fetchRemoteManifest(repo: string, opts: { prerelease: boolean }): Promise<unknown>,
 *     fetchReleasesForStore(repo: string, force: boolean): Promise<unknown>,
 *     fetchReleaseManifest(repo: string, version: string): Promise<unknown>,
 *     settleUpdate(id: unknown, outcome: unknown): Promise<unknown>,
 *     fetchTrustList(force: boolean): Promise<unknown>,
 *     kits: { get(force: boolean): Promise<unknown> },
 *     storeVocabulary(): Promise<unknown>,
 *     uninstallPlugin(id: unknown): Promise<void>,
 *   },
 *   listPlugins: () => unknown[],
 *   installReleaseOnce: (repo: string, tag: string) => Promise<void>,
 *   updateHost: () => Parameters<typeof selfInstallMethod>[0],
 * }} deps
 */
function extensionChannels({ store, listPlugins, installReleaseOnce, updateHost }) {
  return [
    {
      channel: "releases:fetch",
      privileged: false,
      handler: (_e, repo) => store.fetchReleases(String(repo)),
    },
    {
      channel: "github:repoMeta",
      privileged: false,
      handler: (_e, repo) => store.fetchRepoMeta(String(repo)),
    },
    {
      channel: "github:thumbnails",
      privileged: false,
      handler: (e, items, force) =>
        store.resolveThumbnails(
          items,
          (repo, thumb) => {
            if (!e.sender.isDestroyed())
              e.sender.send("github:thumbnail", { repo, thumb });
          },
          !!force,
        ),
    },
    {
      channel: "github:readme",
      privileged: false,
      handler: (_e, repo, ref) => store.fetchReadme(String(repo), String(ref ?? "HEAD")),
    },
    {
      channel: "updates:install",
      privileged: true,
      handler: (_e, repo, tag) => installReleaseOnce(String(repo), String(tag)),
    },
    {
      channel: "updates:support",
      privileged: true,
      handler: (_e, assetNames) =>
        updateSupport(
          selfInstallMethod(updateHost()),
          Array.isArray(assetNames) ? assetNames.map(String) : [],
        ),
    },
    {
      channel: "plugins:list",
      privileged: false,
      handler: () => listPlugins(),
    },
    {
      channel: "plugins:install",
      privileged: true,
      handler: (_e, spec, version) =>
        store.installPlugin(spec, version == null ? undefined : String(version)),
    },
    {
      channel: "plugins:search",
      privileged: false,
      handler: (_e, query, topic, force) => store.searchExtensions(query, topic, force),
    },
    {
      channel: "plugins:remote-manifest",
      privileged: false,
      handler: (_e, repo, opts) =>
        store.fetchRemoteManifest(String(repo), { prerelease: !!(opts && opts.prerelease) }),
    },
    {
      channel: "plugins:releases",
      privileged: false,
      handler: (_e, repo, force) => store.fetchReleasesForStore(String(repo), !!force),
    },
    {
      channel: "plugins:manifest-at",
      privileged: false,
      handler: (_e, repo, version) => store.fetchReleaseManifest(String(repo), String(version)),
    },
    {
      channel: "plugins:settle-update",
      privileged: true,
      handler: (_e, id, outcome) => store.settleUpdate(id, outcome),
    },
    {
      channel: "plugins:trust-list",
      privileged: false,
      handler: (_e, force) => store.fetchTrustList(!!force),
    },
    {
      channel: "plugins:kits",
      privileged: false,
      handler: (_e, force) => store.kits.get(!!force),
    },
    {
      channel: "plugins:store-vocabulary",
      privileged: false,
      handler: () => store.storeVocabulary(),
    },
    {
      channel: "plugins:uninstall",
      privileged: true,
      handler: (_e, id) => store.uninstallPlugin(id),
    },
  ];
}

module.exports = { extensionChannels };
