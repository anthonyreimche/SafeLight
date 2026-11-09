// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Extensions: GitHub repos with a safelight.json manifest, installed into
// userData/plugins/<id>/ and loaded by the renderer as ESM. Repos are fetched
// as release zips or tarballs (codeload) and unpacked in-process, so we carry
// zero extra runtime dependencies.

const fs = require("node:fs");
const path = require("node:path");
const { validRepo } = require("../window-policy.cjs");
const { isOfficialRepo, validManifest } = require("../extension-origins.cjs");
const { replacePlugin, settlePlugin, removePlugin, contains } = require("../plugin-files.cjs");
const { unzip } = require("../unzip.cjs");
const {
  checkInstallFiles,
  compareSemver,
  downloadReleaseFiles,
  isSemver,
  mustContainFor,
  resolveInstallSource,
} = require("../plugin-releases.cjs");
const { bannedReason } = require("./trust.cjs");

const EXTENSION_ID = /^[a-z0-9][a-z0-9._-]*$/i;

// spec: "owner/repo", "owner/repo#ref", or a github.com URL. `ref` is null when
// the spec names none; the install then resolves a release (or the branch).
function parseRepoSpec(spec) {
  let s = String(spec).trim();
  const url = s.match(
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#]+?)(?:\.git)?(?:\/tree\/([^\s]+))?\/?$/
  );
  if (url) return { owner: url[1], repo: url[2], ref: url[3] || null };
  const [repoPart, ref] = s.split("#");
  const m = repoPart.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m) throw new Error("Use owner/repo, owner/repo#branch, or a GitHub URL");
  return { owner: m[1], repo: m[2], ref: ref || null };
}

/**
 * @param {{
 *   pluginsDir: () => string,
 *   pluginWorkDir: () => string,
 *   appVersion: () => string,
 *   fetchTrustList: () => Promise<{ repos: string[], owners: string[], reason: Record<string, string>, unchecked?: boolean }>,
 *   registryVersionsFor: (repo: string) => Promise<object | undefined>,
 *   releases: {
 *     fetchTarballFiles(owner: string, repo: string, ref: string): Promise<Array<{ name: string, data: Buffer }>>,
 *     fetchBuffer(url: string): Promise<Buffer>,
 *     releaseLists: { get(repo: string, opts?: object): Promise<object[]> },
 *   },
 * }} deps
 */
function createInstaller({
  pluginsDir,
  pluginWorkDir,
  appVersion,
  fetchTrustList,
  registryVersionsFor,
  releases,
}) {
  const { fetchTarballFiles, fetchBuffer, releaseLists } = releases;

  // True when this app build is older than the extension's declared minimum
  // supported version, by semver precedence (plugin-releases.cjs mirrors the
  // renderer's helper). A too-old install is refused before any files are
  // written; the renderer can't know minAppVersion until the manifest lands.
  function appOlderThan(minVersion) {
    return compareSemver(appVersion(), minVersion) < 0;
  }

  function installedFolders() {
    try {
      return fs.readdirSync(pluginsDir());
    } catch {
      return [];
    }
  }

  async function installPlugin(spec, version) {
    const { owner, repo, ref } = parseRepoSpec(spec);
    // parseRepoSpec only splits the spec; a name GitHub could resolve differently
    // than banned.json spells it (owner/rep%6f) must not reach the gate or a fetch.
    if (!validRepo(`${owner}/${repo}`)) throw new Error("Bad repository");
    if (version !== undefined && (ref || !isSemver(version)))
      throw new Error(ref ? "Install a branch or a version, not both" : "Bad version");
    // Remote kill-switch: refuse banned repos/owners before any download or write.
    // The renderer enforces this too (nicer UX), but this is the authoritative
    // gate — it holds even if the renderer bundle is tampered with.
    const full = `${owner}/${repo}`;
    const trust = await fetchTrustList();
    if (trust.unchecked && !isOfficialRepo(full))
      throw new Error(
        "Safelight couldn't download its list of blocked extensions, so only official extensions can be installed for now. Check your internet connection and try again."
      );
    const banned = bannedReason(trust, owner, repo);
    if (banned)
      throw new Error(`"${full}" is blocked by Safelight — ${banned}.`);
    let files;
    let release = null;
    let origin = "the repo";
    let skipped = [];
    if (ref) {
      files = await fetchTarballFiles(owner, repo, ref);
    } else {
      const registry = await registryVersionsFor(full);
      const source = await resolveInstallSource({
        repo: full,
        version,
        registry,
        releaseList: () => releaseLists.get(full, { mustContain: mustContainFor(registry) }),
      });
      if (source.kind === "branch") {
        files = await fetchTarballFiles(owner, repo, "HEAD");
      } else {
        release = source.release;
        ({ files, origin, skipped } = await downloadReleaseFiles({
          release,
          fetchBuffer,
          readTarball: (tag) => fetchTarballFiles(owner, repo, tag),
          unzip,
        }));
      }
    }
    const manifest = checkInstallFiles(files, {
      repo: full,
      release,
      origin,
      skipped,
      appOlderThan,
      appVersion: appVersion(),
    });
    if (!contains(pluginsDir(), path.join(pluginsDir(), manifest.id)))
      throw new Error("Bad extension id");
    // Windows and macOS folder names fold case, so this id would land on top of
    // the installed one that only differs in case.
    const lookalike = installedFolders().find(
      (name) => name !== manifest.id && name.toLowerCase() === manifest.id.toLowerCase()
    );
    if (lookalike)
      throw new Error(
        `"${manifest.id}" can't be installed next to "${lookalike}": the two ids differ only in letter case. Uninstall "${lookalike}" first.`
      );
    // Atomic: the files land in a work folder first, and the current install is
    // kept aside as prev until the renderer settles the update (plugin-files.cjs).
    await replacePlugin({
      pluginsDir: pluginsDir(),
      workDir: pluginWorkDir(),
      id: manifest.id,
      files,
    });
    return manifest;
  }

  async function settleUpdate(id, outcome) {
    if (!EXTENSION_ID.test(String(id)))
      throw new Error("Bad extension id");
    if (outcome !== "keep" && outcome !== "rollback")
      throw new Error("Bad update outcome");
    const restored = await settlePlugin({
      pluginsDir: pluginsDir(),
      workDir: pluginWorkDir(),
      id: String(id),
      outcome,
    });
    // A restored copy that no longer parses is one listPlugins would skip too.
    return restored && validManifest(restored) ? restored : null;
  }

  async function uninstallPlugin(id) {
    if (!EXTENSION_ID.test(String(id)))
      throw new Error("Bad extension id");
    return removePlugin({ pluginsDir: pluginsDir(), workDir: pluginWorkDir(), id: String(id) });
  }

  return { installPlugin, settleUpdate, uninstallPlugin };
}

module.exports = { parseRepoSpec, createInstaller };
