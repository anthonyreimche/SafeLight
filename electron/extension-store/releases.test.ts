// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Extension downloads come from any GitHub repo, so their size and their tar
// layout are untrusted: a bomb must be refused without freezing the main
// process, and long paths must keep their full names.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReleases, untar } from "./releases.cjs";
import { createRepoInfo } from "./readme.cjs";
import { createSearch } from "./search.cjs";

const MIB = 1024 * 1024;

function header(
  name: string,
  { size = 0, type = "0", prefix = "", magic = "ustar\u000000" }: {
    size?: number;
    type?: string;
    prefix?: string;
    magic?: string;
  } = {},
) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100);
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  h.write(type, 156);
  h.write(magic, 257);
  if (prefix) h.write(prefix, 345, 155, "utf8");
  return h;
}

function entry(name: string, data: Buffer, opts: Parameters<typeof header>[1] = {}) {
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([header(name, { ...opts, size: data.length }), padded]);
}

const tar = (...parts: Buffer[]) => Buffer.concat([...parts, Buffer.alloc(1024)]);

function paxRecord(key: string, value: string) {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body);
  while (String(length).length + Buffer.byteLength(body) !== length)
    length = String(length).length + Buffer.byteLength(body);
  return `${length}${body}`;
}

type FakeFetch = (url: string, init?: RequestInit) => Promise<Response>;

function releasesWith(fetch: FakeFetch) {
  return createReleases({
    net: { fetch },
    userData: () => os.tmpdir(),
    fileWriter: { write: async () => {} },
    registryVersionsFor: async () => undefined,
  });
}

function streamOf(chunks: number, chunkSize: number, onPull: () => void) {
  let sent = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        onPull();
        if (sent++ >= chunks) controller.close();
        else controller.enqueue(new Uint8Array(chunkSize));
      },
    },
    { highWaterMark: 0 },
  );
}

describe("untar names", () => {
  it("joins the ustar prefix to the name", () => {
    const files = untar(
      tar(entry("chunk-long.js", Buffer.from("x"), { prefix: "repo-abc/dist/assets" })),
    );
    expect(files.map((f) => f.name)).toEqual(["repo-abc/dist/assets/chunk-long.js"]);
  });

  it("takes the path from a PAX extended header", () => {
    const long = `repo-abc/${"deep/".repeat(30)}very-long-name.js`;
    const pax = Buffer.from(paxRecord("mtime", "1") + paxRecord("path", long));
    const files = untar(
      tar(
        entry("repo-abc/PaxHeaders/x", pax, { type: "x" }),
        entry(long.slice(0, 100), Buffer.from("y")),
        entry("repo-abc/after.js", Buffer.from("z")),
      ),
    );
    expect(files.map((f) => f.name)).toEqual([long, "repo-abc/after.js"]);
    expect(files[0].data.toString()).toBe("y");
  });

  it("still reads GNU 'L' longnames and ignores GNU bytes at the prefix offset", () => {
    const long = `repo-abc/${"x".repeat(150)}.js`;
    const gnu = "ustar  \0";
    const files = untar(
      tar(
        entry("././@LongLink", Buffer.from(`${long}\0`), { type: "L", magic: gnu }),
        entry(long.slice(0, 100), Buffer.from("a"), { magic: gnu, prefix: "14512345670" }),
        entry("repo-abc/short.js", Buffer.from("b"), { magic: gnu, prefix: "14512345670" }),
      ),
    );
    expect(files.map((f) => f.name)).toEqual([long, "repo-abc/short.js"]);
  });

  it("skips global PAX headers", () => {
    const files = untar(
      tar(
        entry("pax_global_header", Buffer.from(paxRecord("comment", "abc")), { type: "g" }),
        entry("repo-abc/a.js", Buffer.from("a")),
      ),
    );
    expect(files.map((f) => f.name)).toEqual(["repo-abc/a.js"]);
  });

  it("refuses an archive with too many entries", () => {
    const parts = Array.from({ length: 6 }, (_, i) => entry(`repo/f${i}.js`, Buffer.alloc(0)));
    expect(() => untar(tar(...parts), { maxEntries: 5 })).toThrow(/too many files/);
    expect(untar(tar(...parts.slice(0, 5)), { maxEntries: 5 })).toHaveLength(5);
  });
});

describe("fetchTarballFiles size limits", () => {
  it("refuses a tarball that inflates past the unpacked cap", async () => {
    const member = zlib.gzipSync(Buffer.alloc(16 * MIB));
    const bomb = Buffer.concat(Array<Buffer>(19).fill(member));
    const releases = releasesWith(async () => new Response(bomb));
    await expect(releases.fetchTarballFiles("o", "r", "main")).rejects.toThrow(
      "The extension download is too large.",
    );
  }, 30000);

  it("refuses a Content-Length over the packed cap before reading the body", async () => {
    let pulls = 0;
    const releases = releasesWith(
      async () =>
        new Response(streamOf(1, 1024, () => pulls++), {
          headers: { "content-length": String(100 * MIB) },
        }),
    );
    await expect(releases.fetchTarballFiles("o", "r", "main")).rejects.toThrow(
      "The extension download is too large.",
    );
    expect(pulls).toBe(0);
  });

  it("stops reading a release zip once it passes the packed cap", async () => {
    let pulls = 0;
    const releases = releasesWith(async () => new Response(streamOf(80, MIB, () => pulls++)));
    const outcome = await releases.fetchBuffer("https://example.test/a.zip").then(
      (buf: Buffer) => `${buf.length} bytes`,
      (e: Error) => e.message,
    );
    expect(outcome).toBe("The extension download is too large.");
    expect(pulls).toBeLessThan(70);
  });

  it("unpacks a normal tarball and strips GitHub's top folder", async () => {
    const gz = zlib.gzipSync(
      tar(
        entry("r-main/safelight.json", Buffer.from("{}")),
        entry("index.js", Buffer.from("export {};"), { prefix: "r-main/dist" }),
      ),
    );
    const releases = releasesWith(async () => new Response(gz));
    const files = await releases.fetchTarballFiles("o", "r", "main");
    expect(files.map((f: { name: string }) => f.name)).toEqual(["safelight.json", "dist/index.js"]);
  });

  it("still returns a small release zip", async () => {
    const releases = releasesWith(async () => new Response(Buffer.from("PK zip bytes")));
    const buf = await releases.fetchBuffer("https://example.test/a.zip");
    expect(buf.toString()).toBe("PK zip bytes");
  });
});

describe("store fetch timeouts", () => {
  let root: string;
  const signals: Array<AbortSignal | null | undefined> = [];
  const recording =
    (body: () => Response): FakeFetch =>
    async (_url, init) => {
      signals.push(init?.signal);
      return body();
    };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "safelight-store-"));
    signals.length = 0;
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const expectTimeoutSignals = () => {
    expect(signals.length).toBeGreaterThan(0);
    for (const s of signals) expect(s).toBeInstanceOf(AbortSignal);
  };

  it("fetchReleases passes a timeout signal", async () => {
    await releasesWith(recording(() => Response.json([]))).fetchReleases("o/r");
    expectTimeoutSignals();
  });

  it("fetchRepoMeta passes a timeout signal", async () => {
    const info = createRepoInfo({
      net: { fetch: recording(() => Response.json({ full_name: "o/r" })) },
      fetchOgImage: async () => "",
    });
    await info.fetchRepoMeta("o/r");
    expectTimeoutSignals();
  });

  it("fetchReadme passes a timeout signal on every attempt", async () => {
    const info = createRepoInfo({
      net: { fetch: recording(() => new Response("", { status: 404 })) },
      fetchOgImage: async () => "",
    });
    await expect(info.fetchReadme("o/r", "main")).resolves.toBeNull();
    expect(signals).toHaveLength(4);
    expectTimeoutSignals();
  });

  it("live search passes a timeout signal", async () => {
    const search = createSearch({
      net: { fetch: recording(() => Response.json({ items: [] })) },
      userData: () => root,
      fileWriter: { write: async () => {} },
      registry: { fetchRegistryIndex: async () => null, cachedVocabulary: () => null },
      cachedThumbnail: () => ({ url: "", custom: false }),
    });
    await search.searchExtensions("", "my-topic");
    expectTimeoutSignals();
  });
});
