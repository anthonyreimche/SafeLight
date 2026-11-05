// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// How the in-app updater decides whether this copy can install a release
// itself, which asset it takes, whether the download is the one GitHub
// published, and when it may quit (self-update.cjs). main.cjs wires these in.

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
} from "./self-update.cjs";

const host = (over: Partial<Parameters<typeof selfInstallMethod>[0]> = {}) => ({
  platform: "linux",
  execPath: "/opt/Safelight/safelight",
  env: {},
  osRelease: 'ID=ubuntu\nID_LIKE=debian\n',
  ...over,
});

const ASSETS = [
  "Safelight-3.1.0-arm64.dmg",
  "Safelight-3.1.0-x86_64.flatpak",
  "Safelight-3.1.0.AppImage",
  "Safelight-3.1.0.dmg",
  "safelight-3.1.0.pacman",
  "safelight-3.1.0.x86_64.rpm",
  "Safelight.Setup.3.1.0.exe",
  "Safelight.Setup.3.1.0.exe.blockmap",
  "safelight_3.1.0_amd64.deb",
];

describe("SAFELIGHT_REPO", () => {
  it("is the repo the renderer's update check reads", () => {
    expect(SAFELIGHT_REPO).toBe("anthonyreimche/SafeLight");
  });
});

describe("selfInstallMethod", () => {
  it("runs the NSIS installer on Windows", () => {
    expect(selfInstallMethod(host({ platform: "win32", execPath: "C:\\Safelight.exe" }))).toEqual({
      kind: "installer",
      ext: ".exe",
    });
  });

  it("sends macOS to the release page", () => {
    expect(selfInstallMethod(host({ platform: "darwin" }))).toBeNull();
  });

  // The next launch runs $APPIMAGE, not a copy downloaded to temp.
  it("sends an AppImage to the release page", () => {
    expect(selfInstallMethod(host({ env: { APPIMAGE: "/home/a/Safelight.AppImage" } }))).toBeNull();
  });

  it("sends a Nix install to the release page", () => {
    expect(
      selfInstallMethod(host({ execPath: "/nix/store/abc-electron-42/libexec/electron/electron" })),
    ).toBeNull();
  });

  it("sends a Flatpak to the release page", () => {
    expect(selfInstallMethod(host({ env: { FLATPAK_ID: "com.safelight.app" } }))).toBeNull();
  });

  it.each([
    ['ID=ubuntu\nID_LIKE=debian\n', ".deb"],
    ["ID=debian\n", ".deb"],
    ['ID="fedora"\n', ".rpm"],
    ['ID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n', ".rpm"],
  ])("opens the distro's own package for %j", (osRelease, ext) => {
    expect(selfInstallMethod(host({ osRelease }))).toEqual({ kind: "package", ext });
  });

  // Most Arch setups have nothing that opens a .pacman file from a click.
  it("sends Arch to the release page", () => {
    expect(selfInstallMethod(host({ osRelease: "ID=arch\n" }))).toBeNull();
    expect(selfInstallMethod(host({ osRelease: "ID=endeavouros\nID_LIKE=arch\n" }))).toBeNull();
  });

  it("sends an unknown distro to the release page", () => {
    expect(selfInstallMethod(host({ osRelease: "ID=gentoo\n" }))).toBeNull();
    expect(selfInstallMethod(host({ osRelease: "" }))).toBeNull();
  });

  // electron-builder's .deb and .rpm install under /opt; anything else (a
  // tarball, a dev run) wasn't installed from a package.
  it("offers a package only to a copy installed from one", () => {
    expect(selfInstallMethod(host({ execPath: "/home/a/safelight/safelight" }))).toBeNull();
    expect(
      selfInstallMethod(host({ execPath: "/usr/lib/electron/electron", osRelease: 'ID="fedora"\n' })),
    ).toBeNull();
  });
});

describe("pickAsset", () => {
  const assets = ASSETS.map((name) => ({ name, browser_download_url: `https://x/${name}` }));

  it("takes the setup exe, not its blockmap", () => {
    expect(pickAsset(assets, { kind: "installer", ext: ".exe" })?.name).toBe("Safelight.Setup.3.1.0.exe");
  });

  it("takes the package matching the distro", () => {
    expect(pickAsset(assets, { kind: "package", ext: ".rpm" })?.name).toBe("safelight-3.1.0.x86_64.rpm");
  });

  it("finds nothing without a method or a matching asset", () => {
    expect(pickAsset(assets, null)).toBeNull();
    expect(pickAsset([{ name: "notes.txt" }], { kind: "installer", ext: ".exe" })).toBeNull();
  });
});

describe("updateSupport", () => {
  it("installs when the release carries this platform's asset", () => {
    expect(updateSupport({ kind: "installer", ext: ".exe" }, ASSETS)).toBe("install");
  });

  it("points at the release page when the release has no asset for this platform", () => {
    expect(updateSupport({ kind: "installer", ext: ".exe" }, ["Safelight-3.1.0.dmg"])).toBe("release-page");
  });

  it("points at the release page when this copy can't install itself", () => {
    expect(updateSupport(null, ASSETS)).toBe("release-page");
  });
});

describe("sha256Digest", () => {
  const hex = "ab".repeat(32);

  it("reads GitHub's published asset digest", () => {
    expect(sha256Digest(`sha256:${hex}`)).toBe(hex);
    expect(sha256Digest(`sha256:${hex.toUpperCase()}`)).toBe(hex);
  });

  it("finds none on an asset without a sha256 digest", () => {
    expect(sha256Digest(undefined)).toBeNull();
    expect(sha256Digest(null)).toBeNull();
    expect(sha256Digest(`md5:${hex.slice(0, 32)}`)).toBeNull();
  });
});

describe("downloadVerified", () => {
  const dirs: string[] = [];
  const target = () => {
    const dir = mkdtempSync(join(tmpdir(), "sl-update-"));
    dirs.push(dir);
    return join(dir, "setup.exe");
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const chunks = [Buffer.from("installer "), Buffer.from("bytes")];
  const sha256 = createHash("sha256").update(Buffer.concat(chunks)).digest("hex");
  const body = (parts: Buffer[], stallAfter = Infinity) => {
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i >= stallAfter) return new Promise<void>(() => {});
        if (i < parts.length) controller.enqueue(new Uint8Array(parts[i++]));
        else controller.close();
      },
    });
  };

  it("writes the bytes GitHub published", async () => {
    const file = target();
    await downloadVerified(body(chunks), file, sha256);
    expect(readFileSync(file, "utf8")).toBe("installer bytes");
  });

  it("refuses and removes altered bytes", async () => {
    const file = target();
    await expect(downloadVerified(body([Buffer.from("installer bytez")]), file, sha256)).rejects.toThrow(
      "doesn't match the checksum",
    );
    expect(existsSync(file)).toBe(false);
  });

  it("gives up on a download that stops sending bytes", async () => {
    const file = target();
    await expect(downloadVerified(body(chunks, 1), file, sha256, { stallMs: 30 })).rejects.toThrow(
      "stopped",
    );
    expect(existsSync(file)).toBe(false);
  });
});

describe("fetchWithin", () => {
  afterEach(() => vi.useRealTimers());

  it("rejects and aborts a request that never answers, so the next install can start", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const hung = vi.fn((_url: string, init: { signal?: AbortSignal }) => {
      signal = init.signal;
      return new Promise<never>(() => {});
    });
    const install = vi.fn().mockImplementationOnce(() => fetchWithin(hung, "https://example.test/a", {}, 30_000));
    install.mockResolvedValue(undefined);
    const once = oneAtATime(install);

    const first = once("v1.1.0");
    const settled = expect(first).rejects.toThrow("didn't respond");
    await vi.advanceTimersByTimeAsync(30_000);
    await settled;
    expect(signal?.aborted).toBe(true);

    await once("v1.0.0");
    expect(install).toHaveBeenCalledTimes(2);
  });

  it("hands back a response that arrives in time", async () => {
    const res = { ok: true };
    await expect(fetchWithin(async () => res, "https://example.test/a", {}, 30_000)).resolves.toBe(res);
  });
});

describe("oneAtATime", () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  };

  // The banner and Preferences can both start the same install.
  it("shares an install already under way for the same release", async () => {
    const run = deferred();
    const install = vi.fn(() => run.promise);
    const once = oneAtATime(install);

    const first = once("v1.1.0");
    const second = once("v1.1.0");
    expect(install).toHaveBeenCalledOnce();
    run.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it("refuses a different release while one is under way", async () => {
    const run = deferred();
    const once = oneAtATime(() => run.promise);

    const first = once("v1.1.0");
    await expect(once("v1.0.0")).rejects.toThrow("already downloading");
    run.resolve();
    await first;
  });

  it("starts afresh once the last one has settled, failed or not", async () => {
    const install = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const once = oneAtATime(install);

    await expect(once("v1.1.0")).rejects.toThrow("offline");
    await once("v1.0.0");
    expect(install).toHaveBeenCalledTimes(2);
  });
});

describe("emptyDir", () => {
  it("removes earlier downloads and keeps the folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sl-updates-"));
    try {
      writeFileSync(join(dir, "Safelight.Setup.1.0.0.exe"), "old");
      writeFileSync(join(dir, "safelight_1.0.0_amd64.deb"), "old");
      await emptyDir(dir);
      expect(existsSync(dir)).toBe(true);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does nothing for a folder that isn't there yet", async () => {
    await expect(emptyDir(join(tmpdir(), "sl-updates-missing-x"))).resolves.toBeUndefined();
  });
});

describe("launchDownloaded", () => {
  it("quits once the installer has started", async () => {
    const quit = vi.fn();
    await launchDownloaded("C:\\t\\setup.exe", { kind: "installer", ext: ".exe" }, {
      openPath: async () => "",
      quit,
    });
    expect(quit).toHaveBeenCalledOnce();
  });

  it("stays running when the installer couldn't start, and says why", async () => {
    const quit = vi.fn();
    await expect(
      launchDownloaded("C:\\t\\setup.exe", { kind: "installer", ext: ".exe" }, {
        openPath: async () => "Access is denied.",
        quit,
      }),
    ).rejects.toThrow("Access is denied.");
    expect(quit).not.toHaveBeenCalled();
  });

  it("stays running when opening fails outright", async () => {
    const quit = vi.fn();
    await expect(
      launchDownloaded("/tmp/s.deb", { kind: "package", ext: ".deb" }, {
        openPath: async () => {
          throw new Error("EACCES");
        },
        quit,
      }),
    ).rejects.toThrow("EACCES");
    expect(quit).not.toHaveBeenCalled();
  });

  // The package manager takes it from here; the running copy stays open.
  it("keeps running after handing a package to the system", async () => {
    const quit = vi.fn();
    await launchDownloaded("/tmp/s.deb", { kind: "package", ext: ".deb" }, {
      openPath: async () => "",
      quit,
    });
    expect(quit).not.toHaveBeenCalled();
  });
});
