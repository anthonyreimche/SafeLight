// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// How the main process picks an extension release: version order (held equal
// to the renderer's src/update/semver.ts), GitHub release lists, registry
// version records, the release-list cache, install-source resolution and the
// checks every downloaded file set passes. No network: fetches are injected.

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as appSemver from "../src/update/semver.ts";
import {
  NOTES_CAP,
  allowedZipUrl,
  checkInstallFiles,
  compareSemver,
  createReleaseListCache,
  downloadReleaseFiles,
  findRelease,
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
} from "./plugin-releases.cjs";

const REPO = "acme/widget";
const dl = (tag: string, name = "widget.zip") =>
  `https://github.com/${REPO}/releases/download/${tag}/${name}`;
const gh = (tag: string, over: Record<string, unknown> = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  published_at: "2026-10-01T00:00:00Z",
  body: `Notes for ${tag}`,
  html_url: `https://github.com/${REPO}/releases/tag/${tag}`,
  assets: [],
  ...over,
});

const TABLE = [
  "1.0.0", "1.0.1", "1.1.0", "2.0.0", "v2.0.0", "1.2", "3", "0.0.0",
  "1.3.0-alpha", "1.3.0-beta", "1.3.0-beta.1", "1.3.0-beta.2", "1.3.0-beta.10",
  "1.3.0-rc.1", "1.3.0-1",
  "1.3.0", "1.3.0+build.5",
];

describe("semver mirror", () => {
  it("orders every pair the way src/update/semver.ts does", () => {
    for (const a of TABLE)
      for (const b of TABLE)
        expect(compareSemver(a, b), `${a} vs ${b}`).toBe(appSemver.compareSemver(a, b));
  });

  it("reads versions and pre-releases the way src/update/semver.ts does", () => {
    for (const t of [...TABLE, "nightly", "", "latest", "v"]) {
      expect(isSemver(t), t).toBe(appSemver.isSemver(t));
      expect(isPrerelease(t), t).toBe(appSemver.isPrerelease(t));
    }
  });
});

describe("allowedZipUrl", () => {
  it("accepts the repo's own release downloads, in any letter case", () => {
    expect(allowedZipUrl(dl("v1.3.0"), REPO)).toBe(true);
    expect(allowedZipUrl("https://github.com/Acme/Widget/releases/download/v1/x.zip", REPO)).toBe(true);
  });

  it("refuses other repos, hosts, schemes and paths that climb out", () => {
    for (const url of [
      "https://github.com/evil/widget/releases/download/v1/x.zip",
      "https://github.com/acme/widget-other/releases/download/v1/x.zip",
      "https://example.com/acme/widget/releases/download/v1/x.zip",
      "http://github.com/acme/widget/releases/download/v1/x.zip",
      "https://github.com/acme/widget/releases/download/../../../evil/x.zip",
      "https://github.com/acme/widget/releases/download/..%2f..%2fevil/x.zip",
      "https://github.com/acme/widget/releases/download/v1/..%2F..%2Fevil.zip",
      "https://github.com/acme/widget/releases/download/v1%5c..%5c..%5cevil.zip",
      "not a url",
      42,
    ])
      expect(allowedZipUrl(url, REPO), String(url)).toBe(false);
  });
});

describe("normaliseReleases", () => {
  it("keeps published releases with version tags, newest version first", () => {
    const list = normaliseReleases(
      [gh("v1.2.0"), gh("v1.10.0"), gh("nightly"), gh("v2.0.0", { draft: true }), gh("1.3.0")],
      REPO,
    );
    expect(list.map((r) => r.version)).toEqual(["1.10.0", "1.3.0", "1.2.0"]);
    expect(list[0]).toEqual({
      version: "1.10.0",
      tag: "v1.10.0",
      prerelease: false,
      publishedAt: "2026-10-01T00:00:00Z",
      notes: "Notes for v1.10.0",
      htmlUrl: `https://github.com/${REPO}/releases/tag/v1.10.0`,
      zips: [],
    });
  });

  it("marks pre-releases by GitHub's flag or by the tag", () => {
    const list = normaliseReleases(
      [gh("v1.4.0-beta.1"), gh("v1.3.0", { prerelease: true }), gh("v1.2.0")],
      REPO,
    );
    expect(list.map((r) => [r.version, r.prerelease])).toEqual([
      ["1.4.0-beta.1", true],
      ["1.3.0", true],
      ["1.2.0", false],
    ]);
  });

  it("lists up to three zip assets from the repo's own downloads", () => {
    const asset = (name: string, url = dl("v1.0.0", name)) => ({ name, browser_download_url: url });
    const [r] = normaliseReleases(
      [
        gh("v1.0.0", {
          assets: [
            asset("notes.txt"),
            asset("a.zip"),
            asset("b.ZIP"),
            asset("c.zip", "https://example.com/c.zip"),
            asset("d.zip"),
            asset("e.zip"),
          ],
        }),
      ],
      REPO,
    );
    expect(r.zips).toEqual([
      { name: "a.zip", url: dl("v1.0.0", "a.zip") },
      { name: "b.ZIP", url: dl("v1.0.0", "b.ZIP") },
      { name: "d.zip", url: dl("v1.0.0", "d.zip") },
    ]);
  });

  it("caps release notes", () => {
    const [r] = normaliseReleases([gh("v1.0.0", { body: "x".repeat(NOTES_CAP + 50) })], REPO);
    expect(r.notes.length).toBe(NOTES_CAP + 2);
    expect(r.notes.endsWith("\n…")).toBe(true);
  });

  it("reads anything that isn't a list as no releases", () => {
    expect(normaliseReleases({ message: "Not Found" }, REPO)).toEqual([]);
  });
});

describe("pickLatest / findRelease", () => {
  const list = normaliseReleases([gh("v1.4.0-beta.2"), gh("v1.3.0"), gh("v1.2.0")], REPO);

  it("picks the highest full release unless pre-releases are wanted", () => {
    expect(pickLatest(list)?.version).toBe("1.3.0");
    expect(pickLatest(list, { prerelease: true })?.version).toBe("1.4.0-beta.2");
    expect(pickLatest(normaliseReleases([gh("v2.0.0-rc.1")], REPO))).toBeNull();
  });

  it("finds a release by version, with or without a v", () => {
    expect(findRelease(list, "1.2.0")?.tag).toBe("v1.2.0");
    expect(findRelease(list, "v1.3")?.tag).toBe("v1.3.0");
    expect(findRelease(list, "9.9.9")).toBeNull();
  });
});

describe("parseRegistryVersions", () => {
  it("reads a release source's latest and newer pre-release", () => {
    expect(
      parseRegistryVersions({
        fullName: REPO,
        latest: {
          version: "1.3.0",
          tag: "v1.3.0",
          from: "release",
          minAppVersion: "2.6.0",
          zips: [dl("v1.3.0"), "https://example.com/x.zip"],
        },
        prerelease: { version: "1.4.0-beta.1", tag: "v1.4.0-beta.1", zips: [] },
      }),
    ).toEqual({
      latest: {
        version: "1.3.0",
        tag: "v1.3.0",
        from: "release",
        minAppVersion: "2.6.0",
        zips: [{ name: "widget.zip", url: dl("v1.3.0") }],
      },
      prerelease: { version: "1.4.0-beta.1", tag: "v1.4.0-beta.1", from: "release", zips: [] },
    });
  });

  it("reads a branch source", () => {
    expect(
      parseRegistryVersions({ fullName: REPO, latest: { version: "1.2.0", from: "branch" } }),
    ).toEqual({ latest: { version: "1.2.0", from: "branch", zips: [] } });
  });

  it("keeps a release error", () => {
    expect(
      parseRegistryVersions({ fullName: REPO, releaseError: "v1.3.0: safelight.json says 1.2.0" }),
    ).toEqual({ releaseError: "v1.3.0: safelight.json says 1.2.0" });
  });

  it("drops a pre-release that isn't newer, and rejects malformed records", () => {
    expect(
      parseRegistryVersions({
        fullName: REPO,
        latest: { version: "1.3.0", tag: "v1.3.0", from: "release" },
        prerelease: { version: "1.3.0-beta.1", tag: "v1.3.0-beta.1" },
      })?.prerelease,
    ).toBeUndefined();
    expect(parseRegistryVersions({ fullName: REPO })).toBeNull();
    expect(parseRegistryVersions({ fullName: "not a repo", latest: { version: "1.0.0", from: "branch" } })).toBeNull();
    expect(
      parseRegistryVersions({ fullName: REPO, latest: { version: "1.3.0", tag: "v1.2.0", from: "release" } }),
    ).toBeNull();
    expect(
      parseRegistryVersions({ fullName: REPO, latest: { version: "soon", from: "branch" } }),
    ).toBeNull();
  });

  it("names each zip from its URL path, and drops entries that aren't a plain .zip", () => {
    const zips = [
      `${dl("v1.3.0", "x.zip")}?a=%2F..%2Fevil`,
      `${dl("v1.3.0", "y.zip")}#f`,
      `https://github.com/${REPO}/releases/download/v1.3.0/`,
      dl("v1.3.0", "notes.txt"),
      dl("v1.3.0", "my%20ext.zip"),
    ];
    expect(
      parseRegistryVersions({
        fullName: REPO,
        latest: { version: "1.3.0", tag: "v1.3.0", from: "release", zips },
      })?.latest.zips,
    ).toEqual([
      { name: "x.zip", url: zips[0] },
      { name: "y.zip", url: zips[1] },
      { name: "my ext.zip", url: zips[4] },
    ]);
  });

  it("drops rejected zips before the three-zip cap, so they don't use up its slots", () => {
    const zips = [
      dl("v1.3.0", "notes.txt"),
      `https://github.com/${REPO}/releases/download/v1.3.0/`,
      dl("v1.3.0", "a.zip"),
      dl("v1.3.0", "b.zip"),
      dl("v1.3.0", "c.zip"),
      dl("v1.3.0", "d.zip"),
    ];
    expect(
      parseRegistryVersions({
        fullName: REPO,
        latest: { version: "1.3.0", tag: "v1.3.0", from: "release", zips },
      })?.latest.zips.map((z) => z.name),
    ).toEqual(["a.zip", "b.zip", "c.zip"]);
  });
});

describe("remoteFromRegistry / mustContainFor", () => {
  const versions = parseRegistryVersions({
    fullName: REPO,
    latest: { version: "1.3.0", tag: "v1.3.0", from: "release", minAppVersion: "2.6.0" },
    prerelease: { version: "1.4.0-beta.1", tag: "v1.4.0-beta.1", minAppVersion: "2.7.0" },
  });
  const branch = parseRegistryVersions({ fullName: REPO, latest: { version: "1.2.0", from: "branch" } });

  it("answers the latest full release", () => {
    expect(remoteFromRegistry(versions, false)).toEqual({ version: "1.3.0", minAppVersion: "2.6.0" });
  });

  it("answers the pre-release for someone on a pre-release", () => {
    expect(remoteFromRegistry(versions, true)).toEqual({
      version: "1.4.0-beta.1",
      minAppVersion: "2.7.0",
    });
  });

  it("answers a branch source's version", () => {
    expect(remoteFromRegistry(branch, true)).toEqual({ version: "1.2.0" });
  });

  it("has nothing to offer for a release error", () => {
    expect(remoteFromRegistry({ releaseError: "broken" }, false)).toBeNull();
  });

  it("names the versions a cached release list must hold", () => {
    expect(mustContainFor(versions)).toEqual(["1.3.0", "1.4.0-beta.1"]);
    expect(mustContainFor(branch)).toBeNull();
    expect(mustContainFor(undefined)).toBeNull();
    expect(mustContainFor({ releaseError: "broken" })).toBeNull();
  });
});

const rel = (version: string, prerelease = false) => ({
  version,
  tag: `v${version}`,
  prerelease,
  publishedAt: "",
  notes: "",
  htmlUrl: "",
  zips: [],
});

describe("createReleaseListCache", () => {
  const setup = (stored: unknown = null) => {
    let t = 1_000_000;
    const saved: Record<string, unknown>[] = [];
    const fetchList = vi.fn(async (_repo: string) => [rel("1.3.0"), rel("1.2.0")]);
    const cache = createReleaseListCache({
      load: () => stored,
      save: (map: Record<string, unknown>) => saved.push(map),
      fetchList,
      now: () => t,
      ttlMs: 1000,
      maxAgeMs: 5000,
    });
    return { cache, fetchList, saved, advance: (ms: number) => (t += ms) };
  };

  it("fetches once and serves the copy inside the TTL", async () => {
    const { cache, fetchList, advance } = setup();
    await cache.get(REPO);
    await cache.get(REPO);
    expect(fetchList).toHaveBeenCalledTimes(1);
    advance(1000);
    await cache.get(REPO);
    expect(fetchList).toHaveBeenCalledTimes(2);
  });

  it("keeps a list current while it holds the registry's versions, past the TTL", async () => {
    const { cache, fetchList, advance } = setup();
    await cache.get(REPO);
    advance(10_000);
    await cache.get(REPO, { mustContain: ["1.3.0"] });
    expect(fetchList).toHaveBeenCalledTimes(1);
    await cache.get(REPO, { mustContain: ["1.4.0"] });
    expect(fetchList).toHaveBeenCalledTimes(2);
  });

  it("refetches on force", async () => {
    const { cache, fetchList } = setup();
    await cache.get(REPO);
    await cache.get(REPO, { force: true });
    expect(fetchList).toHaveBeenCalledTimes(2);
  });

  it("starts from the copy on disk", async () => {
    const { cache, fetchList } = setup({ [REPO]: { at: 999_500, releases: [rel("1.1.0")] } });
    expect((await cache.get("Acme/Widget")).map((r) => r.version)).toEqual(["1.1.0"]);
    expect(fetchList).not.toHaveBeenCalled();
  });

  it("shares one fetch between concurrent reads", async () => {
    const { cache, fetchList } = setup();
    await Promise.all([cache.get(REPO), cache.get(REPO)]);
    expect(fetchList).toHaveBeenCalledTimes(1);
  });

  it("prunes entries past the max age when it writes", async () => {
    const { cache, saved } = setup({ "old/one": { at: 0, releases: [] } });
    await cache.get(REPO);
    expect(Object.keys(saved.at(-1) ?? {})).toEqual([REPO]);
  });

  it("passes a failed fetch on and keeps the copy it had", async () => {
    const { cache, fetchList } = setup();
    await cache.get(REPO);
    fetchList.mockRejectedValueOnce(new Error("rate limited"));
    await expect(cache.get(REPO, { force: true })).rejects.toThrow("rate limited");
    expect(await cache.get(REPO)).toHaveLength(2);
  });
});

describe("remoteFromReleases", () => {
  const list = normaliseReleases([gh("v1.4.0-beta.1"), gh("v1.3.0"), gh("v1.2.0")], REPO);
  const manifestsAt = (map: Record<string, unknown>) =>
    vi.fn(async (tag: string) => (tag in map ? map[tag] : null));
  const branchManifest = vi.fn(async () => ({ version: "9.9.9" }));

  it("answers the newest full release with its minAppVersion", async () => {
    const manifestAt = manifestsAt({ "v1.3.0": { version: "1.3.0", minAppVersion: "2.6.0" } });
    expect(await remoteFromReleases({ list, prerelease: false, manifestAt, branchManifest })).toEqual({
      version: "1.3.0",
      minAppVersion: "2.6.0",
    });
  });

  it("answers a pre-release when asked", async () => {
    const manifestAt = manifestsAt({ "v1.4.0-beta.1": { version: "1.4.0-beta.1" } });
    expect(await remoteFromReleases({ list, prerelease: true, manifestAt, branchManifest })).toEqual({
      version: "1.4.0-beta.1",
    });
  });

  it("skips a release whose manifest disagrees with its tag", async () => {
    const manifestAt = manifestsAt({ "v1.3.0": { version: "1.2.9" }, "v1.2.0": { version: "1.2.0" } });
    expect(await remoteFromReleases({ list, prerelease: false, manifestAt, branchManifest })).toEqual({
      version: "1.2.0",
    });
  });

  it("accepts a release whose manifest is missing at the tag", async () => {
    const manifestAt = manifestsAt({});
    expect(await remoteFromReleases({ list, prerelease: false, manifestAt, branchManifest })).toEqual({
      version: "1.3.0",
    });
  });

  it("reads the branch manifest when there are no releases", async () => {
    const manifestAt = manifestsAt({});
    expect(await remoteFromReleases({ list: [], prerelease: false, manifestAt, branchManifest })).toEqual({
      version: "9.9.9",
    });
    expect(
      await remoteFromReleases({ list: [], prerelease: false, manifestAt, branchManifest: async () => null }),
    ).toBeNull();
  });

  it("passes a failed manifest read on", async () => {
    const manifestAt = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(
      remoteFromReleases({ list, prerelease: false, manifestAt, branchManifest }),
    ).rejects.toThrow("offline");
  });
});

describe("resolveInstallSource", () => {
  const versions = parseRegistryVersions({
    fullName: REPO,
    latest: { version: "1.3.0", tag: "v1.3.0", from: "release", zips: [dl("v1.3.0")] },
    prerelease: { version: "1.4.0-beta.1", tag: "v1.4.0-beta.1" },
  });
  const branch = parseRegistryVersions({ fullName: REPO, latest: { version: "1.2.0", from: "branch" } });
  const list = normaliseReleases([gh("v1.4.0-beta.1"), gh("v1.3.0"), gh("v1.2.0")], REPO);
  const releaseList = vi.fn(async () => list);
  beforeEach(() => releaseList.mockClear());

  it("installs the registry's latest without reading the release list", async () => {
    expect(await resolveInstallSource({ repo: REPO, registry: versions, releaseList })).toEqual({
      kind: "release",
      release: versions.latest,
    });
    expect(releaseList).not.toHaveBeenCalled();
  });

  it("installs the offered pre-release from the registry", async () => {
    expect(
      await resolveInstallSource({ repo: REPO, version: "1.4.0-beta.1", registry: versions, releaseList }),
    ).toEqual({ kind: "release", release: versions.prerelease });
    expect(releaseList).not.toHaveBeenCalled();
  });

  it("reads the release list for an older version", async () => {
    const source = await resolveInstallSource({ repo: REPO, version: "1.2.0", registry: versions, releaseList });
    expect(source).toMatchObject({ kind: "release", release: { tag: "v1.2.0" } });
    expect(releaseList).toHaveBeenCalledTimes(1);
  });

  it("refuses a version that doesn't exist", async () => {
    await expect(
      resolveInstallSource({ repo: REPO, version: "9.9.9", registry: versions, releaseList }),
    ).rejects.toThrow("acme/widget has no release 9.9.9.");
  });

  it("installs the branch for a branch source's own version", async () => {
    expect(await resolveInstallSource({ repo: REPO, registry: branch, releaseList })).toEqual({ kind: "branch" });
    expect(
      await resolveInstallSource({ repo: REPO, version: "1.2.0", registry: branch, releaseList }),
    ).toEqual({ kind: "branch" });
    expect(releaseList).not.toHaveBeenCalled();
  });

  it("reads the release list for a version a branch record doesn't name", async () => {
    const source = await resolveInstallSource({ repo: REPO, version: "1.3.0", registry: branch, releaseList });
    expect(source).toMatchObject({ kind: "release", release: { tag: "v1.3.0" } });
  });

  it("refuses with the registry's release error", async () => {
    await expect(
      resolveInstallSource({
        repo: REPO,
        registry: { releaseError: "v1.3.0: safelight.json says 1.2.0" },
        releaseList,
      }),
    ).rejects.toThrow("acme/widget: v1.3.0: safelight.json says 1.2.0");
  });

  it("uses the release list when the registry doesn't list the repo", async () => {
    const source = await resolveInstallSource({ repo: REPO, registry: undefined, releaseList });
    expect(source).toMatchObject({ kind: "release", release: { version: "1.3.0" } });
  });

  it("installs the branch when an unlisted repo has no releases", async () => {
    expect(
      await resolveInstallSource({ repo: REPO, registry: undefined, releaseList: async () => [] }),
    ).toEqual({ kind: "branch" });
  });

  it("never falls back to the branch when the release list can't be read", async () => {
    await expect(
      resolveInstallSource({
        repo: REPO,
        registry: undefined,
        releaseList: async () => {
          throw new Error("rate limited");
        },
      }),
    ).rejects.toThrow("rate limited");
  });

  it("refuses latest when an unlisted repo has only pre-releases", async () => {
    await expect(
      resolveInstallSource({ repo: REPO, registry: undefined, releaseList: async () => [rel("2.0.0-rc.1", true)] }),
    ).rejects.toThrow("acme/widget has only pre-releases; choose one from the version list.");
  });
});

describe("rateLimitMessage", () => {
  const headers = (h: Record<string, string>) => ({ get: (k: string) => h[k] ?? null });

  it("says when GitHub's unsigned limit resets", () => {
    const reset = String(Date.UTC(2026, 9, 8, 14, 30) / 1000);
    expect(
      rateLimitMessage(403, headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }), REPO),
    ).toMatch(/^GitHub's limit for requests without sign-in is reached; try again after .+\.$/);
  });

  it("names the status otherwise", () => {
    expect(rateLimitMessage(500, headers({}), REPO)).toBe(
      "Couldn't read acme/widget's releases from GitHub (500).",
    );
  });
});

const f = (name: string, content = "") => ({ name, data: Buffer.from(content) });
const manifestFile = (over: Record<string, unknown> = {}) =>
  f(
    "safelight.json",
    JSON.stringify({ id: "acme.widget", name: "Widget", version: "1.3.0", main: "dist/index.js", ...over }),
  );
const names = (files: { name: string }[]) => files.map((x) => x.name);

describe("safeEntries / stripSingleRoot", () => {
  it("drops names that could leave the install folder", () => {
    expect(names(safeEntries([f("a.js"), f("../x.js"), f("dist/../../x.js"), f("dir\\x.js"), f("")]))).toEqual([
      "a.js",
    ]);
  });

  it("drops a .. segment even when a folder precedes it", () => {
    expect(names(safeEntries([f("w/../evil.js"), f("a/../b"), f("w/dist/index.js")]))).toEqual(["w/dist/index.js"]);
  });

  it("strips one top-level folder that holds everything", () => {
    expect(names(stripSingleRoot([f("widget/safelight.json"), f("widget/dist/index.js")]))).toEqual([
      "safelight.json",
      "dist/index.js",
    ]);
  });

  it("leaves a root manifest, or several top-level entries, alone", () => {
    expect(names(stripSingleRoot([f("safelight.json"), f("docs/x.md")]))).toEqual(["safelight.json", "docs/x.md"]);
    expect(names(stripSingleRoot([f("a/safelight.json"), f("b/x")]))).toEqual(["a/safelight.json", "b/x"]);
  });
});

describe("downloadReleaseFiles", () => {
  const release = {
    version: "1.3.0",
    tag: "v1.3.0",
    zips: [
      { name: "bad.zip", url: "u1" },
      { name: "good.zip", url: "u2" },
    ],
  };

  it("uses the first zip that holds a manifest", async () => {
    const unzip = vi.fn((buf: Buffer) => {
      if (buf.toString() === "u1") throw new Error("unsupported compression (method 12)");
      return [f("widget/safelight.json"), f("widget/dist/index.js")];
    });
    const readTarball = vi.fn();
    const out = await downloadReleaseFiles({
      release,
      fetchBuffer: async (url: string) => Buffer.from(url),
      readTarball,
      unzip,
    });
    expect(names(out.files)).toEqual(["safelight.json", "dist/index.js"]);
    expect(out.origin).toBe("good.zip");
    expect(out.skipped).toEqual(["bad.zip couldn't be read (unsupported compression (method 12))"]);
    expect(readTarball).not.toHaveBeenCalled();
  });

  it("falls back to the tag's source when no zip has a manifest", async () => {
    const out = await downloadReleaseFiles({
      release,
      fetchBuffer: async () => Buffer.from(""),
      readTarball: async (tag: string) => [f("safelight.json"), f(`source-of-${tag}`)],
      unzip: () => [f("readme.txt")],
    });
    expect(out.origin).toBe("the release's source");
    expect(out.skipped).toEqual(["bad.zip has no safelight.json", "good.zip has no safelight.json"]);
    expect(names(out.files)).toContain("source-of-v1.3.0");
  });

  it("never lets a .. entry under the single root reach the install", async () => {
    const out = await downloadReleaseFiles({
      release: { version: "1.3.0", tag: "v1.3.0", zips: [{ name: "w.zip", url: "u" }] },
      fetchBuffer: async () => Buffer.from(""),
      readTarball: vi.fn(),
      unzip: () => [f("w/safelight.json"), f("w/../evil.js"), f("w/dist/index.js")],
    });
    expect(names(out.files)).toEqual(["safelight.json", "dist/index.js"]);
    expect(out.origin).toBe("w.zip");
  });

  // PowerShell 5.1's Compress-Archive writes "dist\index.js".
  it("reads a zip whose entry names use backslashes", async () => {
    const readTarball = vi.fn();
    const out = await downloadReleaseFiles({
      release: { version: "1.3.0", tag: "v1.3.0", zips: [{ name: "Widget.zip", url: "u" }] },
      fetchBuffer: async () => Buffer.from(""),
      readTarball,
      unzip: () => [f("safelight.json"), f("dist\\index.js")],
    });
    expect(names(out.files)).toEqual(["safelight.json", "dist/index.js"]);
    expect(out.origin).toBe("Widget.zip");
    expect(out.skipped).toEqual([]);
    expect(readTarball).not.toHaveBeenCalled();
  });

  it("still drops a .. entry once its backslashes are normalised", async () => {
    const out = await downloadReleaseFiles({
      release: { version: "1.3.0", tag: "v1.3.0", zips: [{ name: "w.zip", url: "u" }] },
      fetchBuffer: async () => Buffer.from(""),
      readTarball: vi.fn(),
      unzip: () => [f("w\\safelight.json"), f("w\\..\\evil.js"), f("w\\dist\\index.js")],
    });
    expect(names(out.files)).toEqual(["safelight.json", "dist/index.js"]);
    expect(out.origin).toBe("w.zip");
  });
});

describe("checkInstallFiles", () => {
  const base = {
    repo: REPO,
    appVersion: "3.0.0",
    appOlderThan: (v: string) => compareSemver("3.0.0", v) < 0,
  };
  const release = { version: "1.3.0", tag: "v1.3.0" };

  it("returns the manifest of a good release", () => {
    const m = checkInstallFiles([manifestFile(), f("dist/index.js")], { ...base, release, origin: "widget.zip" });
    expect(m.version).toBe("1.3.0");
  });

  it("refuses a release whose manifest disagrees with its tag", () => {
    expect(() =>
      checkInstallFiles([manifestFile({ version: "1.2.0" }), f("dist/index.js")], {
        ...base,
        release,
        origin: "widget.zip",
      }),
    ).toThrow(
      "Release v1.3.0 of acme/widget contains version 1.2.0 in safelight.json; the author needs to fix the release.",
    );
  });

  it("refuses an extension that needs a newer app", () => {
    expect(() =>
      checkInstallFiles([manifestFile({ minAppVersion: "4.0.0" }), f("dist/index.js")], {
        ...base,
        release,
        origin: "widget.zip",
      }),
    ).toThrow(/requires SafeLight 4\.0\.0 or newer/);
  });

  it("names what was skipped when the fallback also lacks the bundle", () => {
    expect(() =>
      checkInstallFiles([manifestFile()], {
        ...base,
        release,
        origin: "the release's source",
        skipped: ["widget.zip couldn't be read (unsupported compression)"],
      }),
    ).toThrow(
      "widget.zip couldn't be read (unsupported compression), and the release's source has no dist/index.js",
    );
  });

  it("only takes the manifest at the root", () => {
    expect(() =>
      checkInstallFiles([f("sub/safelight.json", "{}"), f("dist/index.js")], { ...base, origin: "the repo" }),
    ).toThrow("The repo has no safelight.json");
  });

  it("checks a branch install without a version match", () => {
    const m = checkInstallFiles([manifestFile({ version: "0.9.0" }), f("dist/index.js")], {
      ...base,
      origin: "the repo",
    });
    expect(m.version).toBe("0.9.0");
  });

  it("refuses an invalid manifest", () => {
    expect(() => checkInstallFiles([f("safelight.json", "{nope")], { ...base, origin: "the repo" })).toThrow(
      "The repo's safelight.json isn't valid JSON",
    );
    expect(() =>
      checkInstallFiles([f("safelight.json", JSON.stringify({ id: "x" }))], { ...base, origin: "the repo" }),
    ).toThrow("Invalid safelight.json");
  });
});
