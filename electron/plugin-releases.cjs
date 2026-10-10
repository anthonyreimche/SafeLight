// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// How Safelight picks and fetches an extension release: GitHub release lists,
// the registry index's version records, the on-disk cache of release lists,
// and the checks every downloaded file set passes before it is installed.
// main.cjs supplies the network and the paths; everything here runs in tests.

"use strict";

const path = require("node:path");
const { validRepo } = require("./window-policy.cjs");
const { validManifest } = require("./extension-origins.cjs");

// ── Versions ─────────────────────────────────────────────────────────────────
// A mirror of src/update/semver.ts (main can't import TypeScript);
// plugin-releases.test.ts holds the two to the same answers.

const VERSION_RE = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/;

const stripV = (tag) => String(tag).replace(/^v/i, "");

function isSemver(tag) {
  return VERSION_RE.test(stripV(tag));
}

function parseSemver(tag) {
  const m = stripV(tag).match(VERSION_RE);
  if (!m) return [0, 0, 0];
  return [
    parseInt(m[1], 10) || 0,
    m[2] ? parseInt(m[2], 10) || 0 : 0,
    m[3] ? parseInt(m[3], 10) || 0 : 0,
  ];
}

function parsePrerelease(tag) {
  const m = String(tag).match(/^v?[\d.]+-([0-9A-Za-z.-]+)/i);
  return m ? m[1] : null;
}

function comparePrerelease(a, b) {
  const xs = a.split(".");
  const ys = b.split(".");
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const x = xs[i];
    const y = ys[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) > Number(y) ? 1 : -1;
    } else if (xn !== yn) {
      return yn ? 1 : -1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  }
  const xp = parsePrerelease(a);
  const yp = parsePrerelease(b);
  if (xp === null && yp === null) return 0;
  if (xp === null) return 1;
  if (yp === null) return -1;
  return comparePrerelease(xp, yp);
}

const isNewer = (current, candidate) => compareSemver(candidate, current) > 0;
const isPrerelease = (tag) => parsePrerelease(tag) !== null;

// ── GitHub release lists ─────────────────────────────────────────────────────

const NOTES_CAP = 20 * 1024;
const ZIP_CAP = 3;

/** A download a release of `repo` may install from: the repo's own release
 *  assets on github.com, nothing else. WHATWG keeps %2f and %5c encoded, so an
 *  escaped separator could hide a `..` that the prefix test never sees. */
function allowedZipUrl(url, repo) {
  if (typeof url !== "string") return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(u.pathname);
  } catch {
    return false;
  }
  return (
    u.protocol === "https:" &&
    u.hostname === "github.com" &&
    !u.port &&
    !u.username &&
    u.pathname.toLowerCase().startsWith(`/${String(repo).toLowerCase()}/releases/download/`) &&
    !/%(2f|5c)/i.test(u.pathname) &&
    !decoded.split("/").includes("..")
  );
}

const capNotes = (s) => (s.length > NOTES_CAP ? `${s.slice(0, NOTES_CAP)}\n…` : s);

/** GitHub's releases payload as the releases Safelight can install: published,
 *  tagged with a version, newest version first. */
function normaliseReleases(payload, repo) {
  if (!Array.isArray(payload)) return [];
  return payload
    .filter((r) => r && !r.draft && typeof r.tag_name === "string" && isSemver(r.tag_name))
    .map((r) => ({
      version: stripV(r.tag_name),
      tag: r.tag_name,
      prerelease: !!r.prerelease || isPrerelease(r.tag_name),
      publishedAt: typeof r.published_at === "string" ? r.published_at : "",
      notes: capNotes(typeof r.body === "string" ? r.body : ""),
      htmlUrl: typeof r.html_url === "string" ? r.html_url : "",
      zips: (Array.isArray(r.assets) ? r.assets : [])
        .filter(
          (a) =>
            a &&
            typeof a.name === "string" &&
            /\.zip$/i.test(a.name) &&
            allowedZipUrl(a.browser_download_url, repo),
        )
        .slice(0, ZIP_CAP)
        .map((a) => ({ name: a.name, url: a.browser_download_url })),
    }))
    .sort((a, b) => compareSemver(b.version, a.version));
}

/** The highest release; full releases only unless `prerelease`. */
function pickLatest(list, { prerelease = false } = {}) {
  let best = null;
  for (const r of list)
    if ((prerelease || !r.prerelease) && (!best || isNewer(best.version, r.version))) best = r;
  return best;
}

const findRelease = (list, version) =>
  list.find((r) => compareSemver(r.version, version) === 0) ?? null;

// ── Registry version records ─────────────────────────────────────────────────
// registry.json carries, per extension, the newest release (and a newer
// pre-release) or the branch version, so an update check needs no API call.

const fileName = (url) => {
  const last = new URL(url).pathname.split("/").pop();
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};

function registryRecord(x, repo, from) {
  if (!x || typeof x !== "object" || typeof x.version !== "string" || !isSemver(x.version))
    return null;
  const rec = { version: x.version, from, zips: [] };
  if (from === "release") {
    if (typeof x.tag !== "string" || !isSemver(x.tag) || compareSemver(x.tag, x.version) !== 0)
      return null;
    rec.tag = x.tag;
    if (Array.isArray(x.zips))
      rec.zips = x.zips
        .filter((u) => allowedZipUrl(u, repo))
        .map((url) => ({ name: fileName(url), url }))
        .filter((z) => /\.zip$/i.test(z.name) && !/[\/\\\0]/.test(z.name))
        .slice(0, ZIP_CAP);
  }
  if (typeof x.minAppVersion === "string" && isSemver(x.minAppVersion))
    rec.minAppVersion = x.minAppVersion;
  return rec;
}

/** The version record of one registry.json entry, or null when it has none
 *  (an older registry, or a malformed row): callers then ask GitHub. */
function parseRegistryVersions(e) {
  if (!e || typeof e !== "object" || typeof e.fullName !== "string" || !validRepo(e.fullName))
    return null;
  if (typeof e.releaseError === "string" && e.releaseError.trim())
    return { releaseError: e.releaseError.trim().slice(0, 300) };
  const from = e.latest && (e.latest.from === "branch" || e.latest.from === "release")
    ? e.latest.from
    : null;
  if (!from) return null;
  const latest = registryRecord(e.latest, e.fullName, from);
  if (!latest) return null;
  const out = { latest };
  if (from === "release") {
    const pre = registryRecord(e.prerelease, e.fullName, "release");
    if (pre && isNewer(latest.version, pre.version)) out.prerelease = pre;
  }
  return out;
}

const toRemote = (r) =>
  r.minAppVersion ? { version: r.version, minAppVersion: r.minAppVersion } : { version: r.version };

/** The update check's answer from a registry record. */
function remoteFromRegistry(versions, prerelease) {
  if (!versions || !versions.latest) return null;
  return toRemote(prerelease && versions.prerelease ? versions.prerelease : versions.latest);
}

/** The versions a cached release list must contain to still be current: the
 *  registry's latest and pre-release. Null when the registry has no release
 *  record for the repo, so the cache falls back to its TTL. */
function mustContainFor(versions) {
  if (!versions || !versions.latest || versions.latest.from !== "release") return null;
  return [versions.latest.version, ...(versions.prerelease ? [versions.prerelease.version] : [])];
}

// ── The release-list cache ───────────────────────────────────────────────────
// Release lists come from the GitHub API, which allows 60 unsigned requests an
// hour, so they are kept on disk. For a repo the registry lists, a cached list
// stays current while it contains the registry's versions: the next release
// the registry announces is what makes it stale. Other repos use a TTL.

function sanitizeLists(raw) {
  const out = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw))
    for (const [k, e] of Object.entries(raw))
      if (e && typeof e.at === "number" && Array.isArray(e.releases))
        out[k.toLowerCase()] = { at: e.at, releases: e.releases };
  return out;
}

function createReleaseListCache({ load, save, fetchList, now = Date.now, ttlMs, maxAgeMs }) {
  let entries = null;
  const inflight = new Map();
  const all = () => (entries ??= sanitizeLists(load()));

  const current = (entry, mustContain) => {
    if (!entry) return false;
    if (mustContain)
      return mustContain.every((v) => entry.releases.some((r) => compareSemver(r.version, v) === 0));
    return now() - entry.at < ttlMs;
  };

  function get(repo, { force = false, mustContain = null } = {}) {
    const key = String(repo).toLowerCase();
    const entry = all()[key];
    if (!force && current(entry, mustContain)) return Promise.resolve(entry.releases);
    let run = inflight.get(key);
    if (!run) {
      run = fetchList(repo)
        .then((releases) => {
          const map = all();
          map[key] = { at: now(), releases };
          for (const [k, e] of Object.entries(map)) if (now() - e.at >= maxAgeMs) delete map[k];
          save(map);
          return releases;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, run);
    }
    return run;
  }

  return { get };
}

// ── Answers for repos the registry doesn't describe ──────────────────────────

const CANDIDATES = 5;

/** The newest release whose safelight.json at the tag agrees with it, with
 *  that manifest's minAppVersion. A manifest missing at the tag doesn't
 *  disqualify the release; the install checks the downloaded one anyway. */
async function verifiedLatest(list, prerelease, manifestAt) {
  const pool = list
    .filter((r) => prerelease || !r.prerelease)
    .sort((a, b) => compareSemver(b.version, a.version))
    .slice(0, CANDIDATES);
  for (const r of pool) {
    const m = await manifestAt(r.tag);
    if (m && typeof m.version === "string" && compareSemver(m.version, r.version) !== 0) continue;
    return m && typeof m.minAppVersion === "string" ? { ...r, minAppVersion: m.minAppVersion } : r;
  }
  return null;
}

/** The update check's answer from a repo's own release list, or from its
 *  default-branch manifest when it publishes no releases. */
async function remoteFromReleases({ list, prerelease, manifestAt, branchManifest }) {
  if (list.length === 0) {
    const m = await branchManifest();
    if (!m || typeof m.version !== "string" || !isSemver(m.version)) return null;
    return toRemote({
      version: m.version,
      minAppVersion: typeof m.minAppVersion === "string" ? m.minAppVersion : undefined,
    });
  }
  const r = await verifiedLatest(list, prerelease, manifestAt);
  return r ? toRemote(r) : null;
}

// ── What an install downloads ────────────────────────────────────────────────

const BRANCH = Object.freeze({ kind: "branch" });
const sourceOf = (r) => (r.from === "branch" ? BRANCH : { kind: "release", release: r });

/** What installing `repo` at `version` (latest when absent) downloads. The
 *  registry answers for its own versions; anything else reads the release
 *  list, and a list that can't be read fails the install rather than falling
 *  back to the default branch. */
async function resolveInstallSource({ repo, version, registry, releaseList }) {
  if (registry) {
    if (registry.releaseError) throw new Error(`${repo}: ${registry.releaseError}`);
    if (!version) return sourceOf(registry.latest);
    const named = [registry.latest, registry.prerelease].find(
      (r) => r && compareSemver(r.version, version) === 0,
    );
    if (named) return sourceOf(named);
  }
  const list = await releaseList();
  if (list.length === 0) return BRANCH;
  if (!version) {
    const latest = pickLatest(list);
    if (!latest) throw new Error(`${repo} has only pre-releases; choose one from the version list.`);
    return { kind: "release", release: latest };
  }
  const hit = findRelease(list, version);
  if (!hit) throw new Error(`${repo} has no release ${version}.`);
  return { kind: "release", release: hit };
}

/** The error for a failed release-list request, naming when GitHub's limit for
 *  unsigned requests resets. */
function rateLimitMessage(status, headers, repo) {
  if ((status === 403 || status === 429) && headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(headers.get("x-ratelimit-reset"));
    const at =
      reset > 0
        ? new Date(reset * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : null;
    return at
      ? `GitHub's limit for requests without sign-in is reached; try again after ${at}.`
      : "GitHub's limit for requests without sign-in is reached; try again later.";
  }
  return `Couldn't read ${repo}'s releases from GitHub (${status}).`;
}

// ── Files and checks ─────────────────────────────────────────────────────────

/** Drop entries whose name carries a backslash (a separator on Windows, so it
 *  escapes a "/"-only traversal filter), a ".." segment as written, or one
 *  once normalised. The raw check matters because stripSingleRoot runs next:
 *  it would turn "w/../x" into "../x", which normalising alone never sees. */
function safeEntries(files) {
  return files.filter(
    (f) =>
      f.name &&
      !f.name.includes("\\") &&
      !f.name.split("/").includes("..") &&
      !path.normalize(f.name).split(/[/\\]/).includes(".."),
  );
}

/** Zipping a folder (rather than its contents) puts everything under one
 *  top-level folder; strip it so both kinds of zip install the same. */
function stripSingleRoot(files) {
  if (files.some((f) => f.name === "safelight.json")) return files;
  const tops = new Set(files.map((f) => f.name.split("/")[0]));
  if (tops.size !== 1) return files;
  const [top] = tops;
  if (!files.every((f) => f.name.startsWith(`${top}/`))) return files;
  return files.map((f) => ({ ...f, name: f.name.slice(top.length + 1) })).filter((f) => f.name);
}

/** Zips made on Windows (PowerShell 5.1's Compress-Archive) name entries
 *  "dist\index.js". Normalise those to "/" so they install; safeEntries then
 *  judges the normalised name, so a ".." segment is still dropped. */
const slashed = (files) => files.map((f) => ({ ...f, name: f.name.replaceAll("\\", "/") }));

/** A release's files: the first zip asset holding safelight.json, else the
 *  source tree at its tag. `skipped` says why each zip was passed over, so a
 *  failed install can name it. */
async function downloadReleaseFiles({ release, fetchBuffer, readTarball, unzip }) {
  const skipped = [];
  for (const zip of release.zips) {
    let files;
    try {
      files = stripSingleRoot(safeEntries(slashed(unzip(await fetchBuffer(zip.url)))));
    } catch (e) {
      skipped.push(`${zip.name} couldn't be read (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    if (files.some((f) => f.name === "safelight.json")) return { files, origin: zip.name, skipped };
    skipped.push(`${zip.name} has no safelight.json`);
  }
  return { files: await readTarball(release.tag), origin: "the release's source", skipped };
}

const sentence = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Every install's checks, whatever the files came from: a manifest at the
 *  root, the release's own version, a build new enough, the entry bundle.
 *  Returns the manifest. */
function checkInstallFiles(
  files,
  { repo, release = null, origin = "the repo", skipped = [], appOlderThan, appVersion },
) {
  const fail = (what) => new Error(skipped.length ? `${skipped.join("; ")}, and ${what}` : sentence(what));
  const manifestFile = files.find((f) => f.name === "safelight.json");
  if (!manifestFile) throw fail(`${origin} has no safelight.json`);
  let manifest;
  try {
    manifest = JSON.parse(manifestFile.data.toString("utf8"));
  } catch {
    throw fail(`${origin}'s safelight.json isn't valid JSON`);
  }
  if (!validManifest(manifest)) throw new Error("Invalid safelight.json");
  if (release && compareSemver(manifest.version, release.version) !== 0)
    throw new Error(
      `Release ${release.tag} of ${repo} contains version ${manifest.version} in safelight.json; the author needs to fix the release.`,
    );
  if (manifest.minAppVersion && appOlderThan(manifest.minAppVersion))
    throw new Error(
      `"${manifest.name}" requires SafeLight ${manifest.minAppVersion} or newer — you have ${appVersion}. Update SafeLight first.`,
    );
  if (!files.some((f) => f.name === manifest.main)) throw fail(`${origin} has no ${manifest.main}`);
  return manifest;
}

module.exports = {
  NOTES_CAP,
  allowedZipUrl,
  checkInstallFiles,
  compareSemver,
  createReleaseListCache,
  downloadReleaseFiles,
  findRelease,
  isNewer,
  isPrerelease,
  isSemver,
  mustContainFor,
  normaliseReleases,
  parseRegistryVersions,
  pickLatest,
  rateLimitMessage,
  remoteFromRegistry,
  remoteFromReleases,
  resolveInstallSource,
  safeEntries,
  stripSingleRoot,
  toRemote,
};
