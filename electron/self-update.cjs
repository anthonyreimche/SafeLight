// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The in-app updater's decisions, kept apart from Electron so they can be
// tested: whether this copy can install a release itself, which release asset
// that takes, whether the download is the file GitHub published, and when the
// app may quit for the installer. Everything else (macOS, AppImage, Flatpak,
// Nix, Arch, a copy not installed from a .deb or .rpm) is sent to the release
// page.

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const SAFELIGHT_REPO = "anthonyreimche/SafeLight";

/** The package format a distro's own package manager opens, from /etc/os-release. */
function linuxPackageExt(osRelease) {
  const field = (key) => {
    const m = new RegExp(`^${key}=(.*)$`, "m").exec(osRelease || "");
    return m ? m[1].replace(/^["']|["']$/g, "").toLowerCase().split(/\s+/) : [];
  };
  const ids = [...field("ID"), ...field("ID_LIKE")];
  const isA = (...names) => ids.some((id) => names.some((n) => id === n || id.startsWith(`${n}-`)));
  if (isA("debian", "ubuntu")) return ".deb";
  if (isA("fedora", "rhel", "centos", "suse", "opensuse")) return ".rpm";
  return null;
}

/**
 * How this copy takes an update: `installer` runs the setup and quits,
 * `package` hands the distro package to the system and stays open. Null when
 * it can't install itself.
 * @param {{ platform: string, execPath: string, env: Record<string, string | undefined>, osRelease: string }} host
 * @returns {{ kind: "installer" | "package", ext: string } | null}
 */
function selfInstallMethod({ platform, execPath, env, osRelease }) {
  if (platform === "win32") return { kind: "installer", ext: ".exe" };
  if (platform !== "linux") return null;
  // The next launch runs $APPIMAGE itself; a copy downloaded beside it never replaces it.
  if (env.APPIMAGE || env.FLATPAK_ID) return null;
  // The Nix store is read-only; the flake is updated through Nix.
  if (String(execPath).startsWith("/nix/store/")) return null;
  // electron-builder's .deb and .rpm install under /opt; a tarball or dev run
  // wasn't installed from a package and shouldn't be handed one.
  if (!String(execPath).startsWith("/opt/")) return null;
  const ext = linuxPackageExt(osRelease);
  return ext ? { kind: "package", ext } : null;
}

/** The release asset `method` installs, or null. */
function pickAsset(assets, method) {
  if (!method) return null;
  return (
    assets.find((a) => a && typeof a.name === "string" && a.name.toLowerCase().endsWith(method.ext)) ?? null
  );
}

/**
 * What the update banner can offer for a release with these asset names.
 * @returns {"install" | "release-page"}
 */
function updateSupport(method, assetNames) {
  return pickAsset(assetNames.map((name) => ({ name })), method) ? "install" : "release-page";
}

/** The hex sha256 in GitHub's `sha256:<hex>` asset digest, or null. */
function sha256Digest(digest) {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(typeof digest === "string" ? digest : "");
  return m ? m[1].toLowerCase() : null;
}

/**
 * Stream a download body to `file`, hashing as it goes. Rejects, and removes
 * the file, when no bytes arrive for `stallMs` or the bytes don't hash to
 * `expectedSha256`.
 */
async function downloadVerified(body, file, expectedSha256, { stallMs = 60_000 } = {}) {
  const hash = crypto.createHash("sha256");
  const source = Readable.fromWeb(body);
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => source.destroy(new Error("The download stopped sending data. Try again.")),
      stallMs,
    );
  };
  const meter = new Transform({
    transform(chunk, _encoding, done) {
      arm();
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    arm();
    await pipeline(source, meter, fs.createWriteStream(file));
    if (hash.digest("hex") !== expectedSha256) {
      throw new Error("The download doesn't match the checksum GitHub published for it.");
    }
  } catch (e) {
    await fs.promises.rm(file, { force: true });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `fetchFn(url, init)`, rejected and aborted when no response arrives within
 * `ms`. The download's stall timer only starts once a body exists, so a server
 * that never answers would otherwise hold the install open for good.
 */
async function fetchWithin(fetchFn, url, init, ms) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("The server didn't respond. Try again."));
    }, ms);
  });
  try {
    return await Promise.race([fetchFn(url, { ...init, signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wrap `fn` so a call while one is under way shares it when the arguments
 * match and is refused when they don't.
 */
function oneAtATime(fn) {
  let current = null;
  return (...args) => {
    const key = JSON.stringify(args);
    if (current) {
      return current.key === key
        ? current.promise
        : Promise.reject(new Error("Another update is already downloading."));
    }
    const promise = (async () => fn(...args))().finally(() => {
      current = null;
    });
    current = { key, promise };
    return promise;
  };
}

/** Remove everything in `dir`; a missing folder is already empty. */
async function emptyDir(dir) {
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch (e) {
    if (e && e.code === "ENOENT") return;
    throw e;
  }
  // An installer still running from an earlier attempt holds its file open on
  // Windows; leaving that one behind mustn't block the new download.
  await Promise.all(
    names.map((name) => fs.promises.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {})),
  );
}

/**
 * Open the downloaded file with the system, and quit for an installer only
 * once it has started. `openPath` resolves with an error message, or "" on
 * success, as shell.openPath does.
 */
async function launchDownloaded(file, method, { openPath, quit }) {
  const failure = await openPath(file);
  if (failure) throw new Error(`Couldn't start the installer: ${failure}`);
  if (method.kind === "installer") quit();
}

module.exports = {
  SAFELIGHT_REPO,
  downloadVerified,
  emptyDir,
  fetchWithin,
  launchDownloaded,
  oneAtATime,
  pickAsset,
  selfInstallMethod,
  sha256Digest,
  updateSupport,
};
