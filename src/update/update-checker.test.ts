// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The release checker talks to GitHub, so every test here drives it through a
// stubbed bridge or a stubbed fetch — it must never reach the network. The
// contract under test is that every outcome is a named CheckResult and nothing
// escapes as a rejection: a rate-limited, offline or nonsense response has to
// degrade into "network-error" / "parse-error". Run with `npm test`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updates: null as { install: (repo: string, tag: string) => Promise<void> } | null,
}));

// installVersion() reaches for the one-shot privileged bridge, which is captured
// at renderer boot and cannot be re-claimed inside a test process.
vi.mock("@/native/privileged", () => ({
  claimPrivileged: () => {},
  privilegedFs: () => null,
  privilegedUpdates: () => mocks.updates,
}));

import {
  checkForUpdate,
  checkForUpdateFull,
  checkForUpdateNow,
  dismissVersion,
  fetchAllReleases,
  getDismissedVersion,
  installVersion,
  openUrl,
} from "./update-checker.ts";

const DISMISS_KEY = "sl_update_dismissed_v1";

interface GHRelease {
  tag_name: string;
  html_url: string;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
}

const release = (over: Partial<GHRelease> & Pick<GHRelease, "tag_name">): GHRelease => ({
  html_url: `https://github.com/anthonyreimche/SafeLight/releases/tag/${over.tag_name}`,
  body: "Release notes",
  draft: false,
  prerelease: false,
  ...over,
});

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  } satisfies Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

/** Only the slice of the Electron bridge update-checker.ts reaches for. */
interface UpdateBridge {
  appVersion?: () => Promise<string>;
  releases?: { fetch: (repo: string) => Promise<unknown> };
}

const windowOpen = vi.fn();

function stubNative(native?: UpdateBridge): void {
  vi.stubGlobal("window", { safelightNative: native, open: windowOpen });
}

/** Bridge that reports `version` as the running build and serves `releases`. */
const bridge = (version: string, releases: unknown): UpdateBridge => ({
  appVersion: () => Promise.resolve(version),
  releases: { fetch: () => Promise.resolve(releases) },
});

let storage: ReturnType<typeof memoryStorage>;

beforeEach(() => {
  mocks.updates = null;
  storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("no test stubbed fetch"))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("checkForUpdateFull — the update decision", () => {
  it("reports an available update with the tag and release page", async () => {
    stubNative(bridge("1.0.0", [release({ tag_name: "v1.1.0" })]));

    await expect(checkForUpdateFull()).resolves.toEqual({
      kind: "update-available",
      currentVersion: "1.0.0",
      info: {
        version: "1.1.0",
        tag: "v1.1.0",
        releasesUrl: "https://github.com/anthonyreimche/SafeLight/releases/tag/v1.1.0",
      },
    });
  });

  it("reports up-to-date when the latest release matches the running build", async () => {
    stubNative(bridge("1.1.0", [release({ tag_name: "v1.1.0" })]));

    await expect(checkForUpdateFull()).resolves.toEqual({
      kind: "up-to-date",
      currentVersion: "1.1.0",
      latestVersion: "1.1.0",
    });
  });

  it("reports up-to-date when the running build is ahead of the registry", async () => {
    stubNative(bridge("2.0.0", [release({ tag_name: "v1.9.0" })]));

    await expect(checkForUpdateFull()).resolves.toMatchObject({ kind: "up-to-date" });
  });

  it("picks the highest version, not the most recently published", async () => {
    // GitHub orders by publish date, so a patch on an old line can appear first.
    stubNative(
      bridge("1.0.0", [
        release({ tag_name: "v1.2.0" }),
        release({ tag_name: "v1.10.0" }),
        release({ tag_name: "v1.9.3" }),
      ]),
    );

    await expect(checkForUpdateFull()).resolves.toMatchObject({
      kind: "update-available",
      info: { version: "1.10.0" },
    });
  });

  it("ignores drafts even when they carry the highest tag", async () => {
    stubNative(
      bridge("1.0.0", [
        release({ tag_name: "v9.0.0", draft: true }),
        release({ tag_name: "v1.1.0" }),
      ]),
    );

    await expect(checkForUpdateFull()).resolves.toMatchObject({
      info: { version: "1.1.0" },
    });
  });

  it("reports no-releases when the repo has none that qualify", async () => {
    stubNative(bridge("1.0.0", []));
    await expect(checkForUpdateFull()).resolves.toEqual({ kind: "no-releases" });

    stubNative(bridge("1.0.0", [release({ tag_name: "v2.0.0", draft: true })]));
    await expect(checkForUpdateFull()).resolves.toEqual({ kind: "no-releases" });
  });
});

describe("checkForUpdateFull — release channels", () => {
  const releases = [
    release({ tag_name: "v1.1.0" }),
    release({ tag_name: "v2.0.0-beta.1", prerelease: true }),
  ];

  it("holds the stable channel back at the last full release", async () => {
    stubNative(bridge("1.0.0", releases));

    await expect(checkForUpdateFull("stable")).resolves.toMatchObject({
      info: { version: "1.1.0" },
    });
  });

  it("offers the pre-release on the all channel", async () => {
    stubNative(bridge("1.0.0", releases));

    await expect(checkForUpdateFull("all")).resolves.toMatchObject({
      info: { version: "2.0.0-beta.1", tag: "v2.0.0-beta.1" },
    });
  });

  it("finds nothing on the stable channel when every release is a pre-release", async () => {
    stubNative(bridge("1.0.0", [release({ tag_name: "v2.0.0-rc.1", prerelease: true })]));

    await expect(checkForUpdateFull("stable")).resolves.toEqual({ kind: "no-releases" });
  });

  it("defaults to the stable channel", async () => {
    stubNative(bridge("1.0.0", [release({ tag_name: "v2.0.0-rc.1", prerelease: true })]));

    await expect(checkForUpdateFull()).resolves.toEqual(await checkForUpdateFull("stable"));
  });
});

describe("checkForUpdateFull — failure modes", () => {
  it("degrades to network-error when the bridge rejects", async () => {
    stubNative({
      appVersion: () => Promise.resolve("1.0.0"),
      releases: { fetch: () => Promise.reject(new Error("ENOTFOUND")) },
    });

    await expect(checkForUpdateFull()).resolves.toEqual({ kind: "network-error" });
  });

  it("degrades to network-error when the bridge throws synchronously", async () => {
    stubNative({
      appVersion: () => Promise.resolve("1.0.0"),
      releases: {
        fetch: () => {
          throw new Error("bridge gone");
        },
      },
    });

    await expect(checkForUpdateFull()).resolves.toEqual({ kind: "network-error" });
  });

  it("degrades to parse-error when GitHub answers with something other than a list", async () => {
    // The classic case is the rate-limit body: `{ message: "API rate limit …" }`.
    for (const payload of [{ message: "API rate limit exceeded" }, null, "", 42]) {
      stubNative(bridge("1.0.0", payload));
      await expect(checkForUpdateFull()).resolves.toEqual({ kind: "parse-error" });
    }
  });

  it("reports current-version-unknown when the running version is unreadable", async () => {
    stubNative(bridge("dev", [release({ tag_name: "v1.1.0" })]));

    await expect(checkForUpdateFull()).resolves.toEqual({
      kind: "current-version-unknown",
      rawVersion: "dev",
    });
  });

  it("reads an all-zero version as a real build, not a parse failure", async () => {
    stubNative(bridge("0.0.0", [release({ tag_name: "v1.1.0" })]));

    await expect(checkForUpdateFull()).resolves.toMatchObject({
      kind: "update-available",
      currentVersion: "0.0.0",
    });
  });

  it("reports current-version-unknown for an empty version string", async () => {
    stubNative(bridge("", [release({ tag_name: "v1.1.0" })]));

    await expect(checkForUpdateFull()).resolves.toEqual({
      kind: "current-version-unknown",
      rawVersion: "",
    });
  });

  it("answers no-releases before it worries about the running version", async () => {
    stubNative(bridge("dev", []));

    await expect(checkForUpdateFull()).resolves.toEqual({ kind: "no-releases" });
  });

  it("falls back to the build-time version when the bridge cannot report one", async () => {
    stubNative({ releases: { fetch: () => Promise.resolve([release({ tag_name: "v0.0.1" })]) } });

    await expect(checkForUpdateFull()).resolves.toEqual({
      kind: "up-to-date",
      currentVersion: __APP_VERSION__,
      latestVersion: "0.0.1",
    });
  });

  it("falls back to the build-time version when the bridge's report rejects", async () => {
    stubNative({
      appVersion: () => Promise.reject(new Error("ipc closed")),
      releases: { fetch: () => Promise.resolve([release({ tag_name: "v0.0.1" })]) },
    });

    await expect(checkForUpdateFull()).resolves.toMatchObject({
      currentVersion: __APP_VERSION__,
    });
  });
});

describe("checkForUpdateFull — browser build (no Electron bridge)", () => {
  const okResponse = (data: unknown) => ({ ok: true, json: () => Promise.resolve(data) });

  it("queries the SafeLight releases endpoint directly", async () => {
    // No bridge means no appVersion(), so the running version is the build-time
    // constant — the release has to out-rank whatever package.json currently says.
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(okResponse([release({ tag_name: "v99.0.0" })])),
    );
    vi.stubGlobal("fetch", fetchMock);
    stubNative();

    const result = await checkForUpdateFull();

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/anthonyreimche/SafeLight/releases?per_page=20",
    );
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({
      Accept: "application/vnd.github+json",
    });
    expect(result).toMatchObject({
      kind: "update-available",
      currentVersion: __APP_VERSION__,
      info: { version: "99.0.0" },
    });
  });

  it("degrades to network-error on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve([]) })),
    );
    stubNative();

    await expect(checkForUpdateFull()).resolves.toEqual({ kind: "network-error" });
  });

  it("degrades to network-error when the request itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    stubNative();

    await expect(checkForUpdateFull()).resolves.toEqual({ kind: "network-error" });
  });

  it("degrades to network-error when the body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({ ok: true, json: () => Promise.reject(new SyntaxError("bad json")) }),
      ),
    );
    stubNative();

    await expect(checkForUpdateFull()).resolves.toEqual({ kind: "network-error" });
  });

  it("degrades to network-error when there is no window at all", async () => {
    // The worker/prerender case: touching `window` throws a ReferenceError, which
    // still has to surface as a result rather than a rejection.
    await expect(checkForUpdateFull()).resolves.toEqual({ kind: "network-error" });
  });
});

describe("checkForUpdate — the startup banner", () => {
  it("surfaces a newer release", async () => {
    stubNative(bridge("1.0.0", [release({ tag_name: "v1.1.0" })]));

    await expect(checkForUpdate()).resolves.toMatchObject({ version: "1.1.0" });
  });

  it("stays quiet for every non-update outcome", async () => {
    stubNative(bridge("1.1.0", [release({ tag_name: "v1.1.0" })]));
    await expect(checkForUpdate()).resolves.toBeNull();

    stubNative(bridge("1.0.0", []));
    await expect(checkForUpdate()).resolves.toBeNull();

    stubNative({
      appVersion: () => Promise.resolve("1.0.0"),
      releases: { fetch: () => Promise.reject(new Error("offline")) },
    });
    await expect(checkForUpdate()).resolves.toBeNull();
  });

  it("stays quiet for a version the user already dismissed", async () => {
    storage.setItem(DISMISS_KEY, "1.1.0");
    stubNative(bridge("1.0.0", [release({ tag_name: "v1.1.0" })]));

    await expect(checkForUpdate()).resolves.toBeNull();
  });

  it("speaks up again once a newer version than the dismissed one ships", async () => {
    storage.setItem(DISMISS_KEY, "1.1.0");
    stubNative(bridge("1.0.0", [release({ tag_name: "v1.2.0" })]));

    await expect(checkForUpdate()).resolves.toMatchObject({ version: "1.2.0" });
  });
});

describe("dismissal storage", () => {
  it("round-trips the dismissed version", () => {
    expect(getDismissedVersion()).toBeNull();
    dismissVersion("1.1.0");
    expect(getDismissedVersion()).toBe("1.1.0");
  });

  it("treats an unavailable localStorage as nothing dismissed", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
      removeItem: () => {},
    } satisfies Pick<Storage, "getItem" | "setItem" | "removeItem">);

    expect(() => dismissVersion("1.1.0")).not.toThrow();
    expect(getDismissedVersion()).toBeNull();
  });
});

describe("fetchAllReleases", () => {
  it("returns every non-draft release, pre-releases included", async () => {
    stubNative(
      bridge("1.0.0", [
        release({ tag_name: "v1.1.0" }),
        release({ tag_name: "v2.0.0-beta.1", prerelease: true, body: null }),
        release({ tag_name: "v9.0.0", draft: true }),
      ]),
    );

    await expect(fetchAllReleases()).resolves.toEqual([
      {
        version: "1.1.0",
        tag: "v1.1.0",
        releasesUrl: "https://github.com/anthonyreimche/SafeLight/releases/tag/v1.1.0",
        body: "Release notes",
        prerelease: false,
      },
      {
        version: "2.0.0-beta.1",
        tag: "v2.0.0-beta.1",
        releasesUrl:
          "https://github.com/anthonyreimche/SafeLight/releases/tag/v2.0.0-beta.1",
        body: "",
        prerelease: true,
      },
    ]);
  });

  it("returns null rather than an empty list when the fetch fails", async () => {
    stubNative({ releases: { fetch: () => Promise.reject(new Error("offline")) } });

    await expect(fetchAllReleases()).resolves.toBeNull();
  });

  it("returns null on a payload it cannot read", async () => {
    stubNative(bridge("1.0.0", { message: "Not Found" }));

    await expect(fetchAllReleases()).resolves.toBeNull();
  });
});

describe("installVersion", () => {
  it("refuses outside the desktop app", async () => {
    stubNative();

    await expect(installVersion("v1.1.0")).rejects.toThrow(
      "In-app install is only available in the desktop app.",
    );
  });

  it("hands the SafeLight repo and the requested tag to the installer", async () => {
    const install = vi.fn(() => Promise.resolve());
    mocks.updates = { install };
    stubNative();

    await installVersion("v1.1.0");

    expect(install).toHaveBeenCalledWith("anthonyreimche/SafeLight", "v1.1.0");
  });
});

describe("checkForUpdateNow", () => {
  it("ignores its legacy version argument and reports the full result", async () => {
    stubNative(bridge("1.0.0", [release({ tag_name: "v1.1.0" })]));

    const fromStaleArg = await checkForUpdateNow("0.0.1");
    const fromCorrectArg = await checkForUpdateNow("1.0.0");

    expect(fromStaleArg).toEqual(fromCorrectArg);
    expect(fromStaleArg).toMatchObject({ kind: "update-available", currentVersion: "1.0.0" });
  });
});

describe("openUrl", () => {
  it("opens the release page in a new, disowned tab", () => {
    stubNative();

    openUrl("https://github.com/anthonyreimche/SafeLight/releases");

    expect(windowOpen).toHaveBeenCalledWith(
      "https://github.com/anthonyreimche/SafeLight/releases",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
