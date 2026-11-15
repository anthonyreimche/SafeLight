// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The extension store backend as one object: trust lists, registry index, search,
// thumbnails, releases and install. main.cjs and `slu` each build it with their
// own network, paths and writer. Changes to the plugin folders (the swap of an
// install, settling an update, uninstalling) run under <userData>/plugins.lock, so
// the app and `slu` never change them at once, and the app's startup sweep
// (main.cjs) waits for it. Downloads stay outside the lock so installs overlap.

const path = require("node:path");
const { withLock } = require("../file-lock.cjs");
const { createTrustList } = require("./trust.cjs");
const { createRegistryIndex, createKitsIndex } = require("./registry.cjs");
const { createThumbnails } = require("./thumbnails.cjs");
const { createSearch } = require("./search.cjs");
const { createReleases } = require("./releases.cjs");
const { createInstaller } = require("./install.cjs");
const { createRepoInfo } = require("./readme.cjs");

const PLUGINS_LOCK = "plugins.lock";
const INSTALL_WAIT_MS = 30_000;

/** The lock that guards plugins/ and plugins-update/ under `userDataDir`. */
const pluginsLockFile = (userDataDir) => path.join(userDataDir, PLUGINS_LOCK);

/**
 * Runs a piece of work under the plugins lock.
 * @param {{
 *   lockFile: () => string,
 *   owner?: "safelight" | "slu",
 *   waitMs?: number,
 *   pollMs?: number,
 * }} lock
 * @returns {<T>(work: () => Promise<T>) => Promise<T>}
 */
function pluginsLocker({ lockFile, owner = "safelight", waitMs = INSTALL_WAIT_MS, pollMs }) {
  return (work) => withLock(lockFile(), owner, work, { waitMs, pollMs });
}

/**
 * @param {{
 *   net: Pick<Electron.Net, "fetch">,
 *   userData: () => string,
 *   fileWriter: { write(file: string, data: Uint8Array): Promise<void> },
 *   appVersion: () => string,
 *   pluginsDir: () => string,
 *   pluginWorkDir: () => string,
 *   lockOwner?: "safelight" | "slu",
 * }} deps
 */
function createExtensionStore({ net, userData, fileWriter, appVersion, pluginsDir, pluginWorkDir, lockOwner }) {
  const trust = createTrustList({ net, userData, fileWriter });
  const registry = createRegistryIndex({ net, userData, fileWriter });
  const thumbnails = createThumbnails({ net, userData, fileWriter });
  const releases = createReleases({
    net,
    userData,
    fileWriter,
    registryVersionsFor: registry.registryVersionsFor,
  });
  const { searchExtensions } = createSearch({
    net,
    userData,
    fileWriter,
    registry,
    cachedThumbnail: thumbnails.cachedThumbnail,
  });
  const { fetchRepoMeta, fetchReadme } = createRepoInfo({
    net,
    fetchOgImage: thumbnails.fetchOgImage,
  });
  const { installPlugin, settleUpdate, uninstallPlugin } = createInstaller({
    pluginsDir,
    pluginWorkDir,
    appVersion,
    fetchTrustList: trust.fetchTrustList,
    registryVersionsFor: registry.registryVersionsFor,
    releases,
    underLock: pluginsLocker({ lockFile: () => pluginsLockFile(userData()), owner: lockOwner }),
  });
  return {
    fetchTrustList: trust.fetchTrustList,
    storeVocabulary: registry.storeVocabulary,
    kits: createKitsIndex({ net, userData }),
    searchExtensions,
    resolveThumbnails: thumbnails.resolveThumbnails,
    fetchRepoMeta,
    fetchReadme,
    fetchReleases: releases.fetchReleases,
    fetchRemoteManifest: releases.fetchRemoteManifest,
    fetchReleasesForStore: releases.fetchReleasesForStore,
    fetchReleaseManifest: releases.fetchReleaseManifest,
    installPlugin,
    settleUpdate,
    uninstallPlugin,
  };
}

module.exports = { createExtensionStore, pluginsLocker, pluginsLockFile, PLUGINS_LOCK };
