// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A RAW the decoder can't use costs a full libraw run every time something asks
// for it. Once its decode has failed for good, the "Cache all" pass and Develop
// remember that in the develop-preview cache and stop asking, until the decoder
// changes or the photo is imported again. "For good" means in two sessions: one
// session's failure may be its own lack of memory, so it is retried. Each
// session is a fresh load of the app's modules. The decoder is faked; the cache
// module is real down to the worker, whose store is a map of keys to texts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "@/catalog/types";
import type { DecodeFailure, RawFloatImage } from "@/raw/decode";
import { rawPhoto } from "./raw-photo.test-support";

const h = vi.hoisted(() => ({
  /** Every key the cache worker holds, previews and markers alike. */
  stored: new Map<string, string>(),
  /** What the full decode answers, given the request's signal. */
  decodeResult: (_signal?: AbortSignal): RawFloatImage | DecodeFailure => ({
    failure: "unsupported",
  }),
  /** Each full decode, by who asked for it. */
  decodes: [] as ("pass" | "develop")[],
  /** A ruling imposed on the colour check; null accepts any decode. */
  verdict: null as { use: boolean; cache: boolean } | null,
  preview: null as Blob | null,
  catalog: [] as CatalogPhoto[],
}));

vi.mock("@/raw/cache-bridge", () => ({
  setCacheDirOnWorker: () => {},
  workerReadCachedPreview: async () => null,
  workerWriteCachedPreview: async (key: string) => void h.stored.set(key, "preview"),
  workerWriteMarker: async (key: string, value: string) => void h.stored.set(key, value),
  workerReadMarker: async (key: string) => h.stored.get(key) ?? null,
  workerDeleteCachedPreview: async (key: string) => void h.stored.delete(key),
  workerClearRawCache: async () => h.stored.clear(),
  workerCachedKeys: async () => [...h.stored.keys()],
}));

vi.mock("@/raw/decode", () => ({
  decodeRawToBitmap: async () => null,
  decodeRawToFloat: async (
    _file: Blob,
    request?: { background?: boolean; signal?: AbortSignal },
  ) => {
    h.decodes.push(request?.background ? "pass" : "develop");
    return h.decodeResult(request?.signal);
  },
}));

vi.mock("@/raw/accept-decode", () => ({
  acceptDecode: async (decode: { suspicious?: boolean }) =>
    h.verdict ?? { use: true, cache: !decode.suspicious },
}));

vi.mock("@/modules/library/raw-preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/library/raw-preview")>()),
  extractRawPreview: async () => h.preview,
  extractRawPreviewDecoded: async () => null,
}));

vi.mock("@/catalog/exif", () => ({
  parseExif: async () => ({}),
  parseXmp: async () => ({}),
  parseExifDate: () => undefined,
}));

vi.mock("./import-thumb-task", () => ({ createThumbnail: async () => new Blob(["thumb"]) }));
vi.mock("./import-thumb-pool", () => ({ processThumb: async () => ({ ok: false }) }));

vi.mock("@/raw/libraw-wasm-adapter", () => ({
  extractRawMetadata: async () => undefined,
}));

vi.mock("@/raw/decode-pool", () => ({ decodePoolSize: () => 3, warmDecodePool: async () => {} }));

vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({
    previewSource: "auto",
    thumbMaxEdge: 768,
    rawCacheEnabled: true,
    rawCachePrefetch: true,
    rawCacheMaxEdge: 3072,
  }),
}));

vi.mock("@/catalog/storage", () => ({ catalogStorage: () => ({ putPhoto: async () => {} }) }));

vi.mock("@/state/catalog-store", () => ({
  useCatalogStore: { getState: () => ({ photos: h.catalog }) },
}));

/** The app as a new page load (a new session) runs it, a second after the last
 *  thing that happened: only a strike from before a session's load counts
 *  towards a final marker. */
async function session() {
  vi.setSystemTime(Date.now() + 1000);
  vi.resetModules();
  const library = await import("./import-photos");
  const { loadPhotoImage } = await import("@/catalog/load-image");
  const cache = await import("@/raw/raw-cache");
  return { ...library, loadPhotoImage, cache };
}

/** One "Cache all" pass of `photo` in each of `count` new sessions. */
async function passesInNewSessions(photo: CatalogPhoto, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const app = await session();
    await app.preDecodeRawsForCache([photo]);
  }
}

const embeddedJpeg = new Blob(["jpeg"], { type: "image/jpeg" });

function floatDecode(extra: Partial<RawFloatImage> = {}): RawFloatImage {
  return {
    data: new Float32Array(4 * 2 * 4).fill(0.18),
    width: 4,
    height: 2,
    oriented: true,
    ...extra,
  };
}

function raw(name: string, fields: Partial<CatalogPhoto> = {}): CatalogPhoto {
  const photo = rawPhoto(name, { bytes: 8, ...fields });
  h.catalog.push(photo);
  return photo;
}

beforeEach(() => {
  h.stored = new Map();
  h.decodeResult = () => ({ failure: "unsupported" });
  h.decodes = [];
  h.verdict = null;
  h.preview = null;
  h.catalog = [];
  vi.stubGlobal(
    "createImageBitmap",
    async (): Promise<ImageBitmap> => ({ width: 6000, height: 4000, close() {} }) as ImageBitmap,
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the Cache all pass and a RAW the decoder can't use", () => {
  it("stops retrying a photo libraw failed on in two sessions", async () => {
    await passesInNewSessions(raw("B.ARW"), 4);

    expect(h.decodes).toEqual(["pass", "pass"]);
  });

  // An out-of-memory decode answers like an unsupported one; within the
  // session that ran short, it is still worth another try.
  it("keeps retrying within the session that failed it", async () => {
    const photo = raw("B.ARW");
    const app = await session();

    await app.preDecodeRawsForCache([photo]);
    await app.preDecodeRawsForCache([photo]);
    await app.loadPhotoImage(photo);

    expect(h.decodes).toEqual(["pass", "pass", "develop"]);
  });

  it("tries again on every pass when the decoder was unavailable", async () => {
    h.decodeResult = () => ({ failure: "transient" });

    await passesInNewSessions(raw("B.ARW"), 3);

    expect(h.decodes).toEqual(["pass", "pass", "pass"]);
  });

  it("counts no strike for a decode the project was left during", async () => {
    const photo = raw("B.ARW");
    const project = new AbortController();
    h.decodeResult = (signal) => {
      project.abort();
      return signal?.aborted ? { failure: "aborted" } : { failure: "unsupported" };
    };

    await (await session()).preDecodeRawsForCache([photo], { signal: project.signal });
    h.decodeResult = () => ({ failure: "unsupported" });
    await passesInNewSessions(photo, 2);

    expect(h.decodes).toEqual(["pass", "pass", "pass"]);
  });

  it("strikes nothing for a pass whose project changed mid-decode", async () => {
    const photo = raw("B.ARW");
    const app = await session();
    h.decodeResult = () => {
      app.cache.setRawCacheDir({ name: "B" } as FileSystemDirectoryHandle);
      return { failure: "unsupported" };
    };

    await app.preDecodeRawsForCache([photo], { force: true });

    expect([...h.stored.keys()]).toEqual([]);
  });

  it("tries a photo once more when the decoder that failed on it is replaced", async () => {
    const photo = raw("B.ARW");
    const { cache } = await session();
    const key = cache.rawCacheKey(photo.relPath, photo.fileSize, 0);
    const final = cache.decodeMarkerKey(key, "unsupported");
    h.stored.set(final.replace(cache.DECODER_ID, "libraw-0.21.3+1"), "an older session");

    await passesInNewSessions(photo, 1);

    expect(h.decodes).toEqual(["pass"]);
  });

  it("tries a photo again once it is imported again", async () => {
    const photo = raw("B.ARW");
    await passesInNewSessions(photo, 2);

    const app = await session();
    await app.reimportPhotos([photo]);
    h.decodes = [];
    await app.preDecodeRawsForCache([photo]);

    expect(h.decodes).toEqual(["pass"]);
  });

  it("tries a photo again after the preview cache is cleared", async () => {
    const photo = raw("B.ARW");
    await passesInNewSessions(photo, 2);

    const app = await session();
    await app.cache.clearRawCache();
    await app.preDecodeRawsForCache([photo]);

    expect(h.decodes).toEqual(["pass", "pass", "pass"]);
  });

  it("remembers a colour rejection from two sessions; Develop shows the camera's", async () => {
    h.decodeResult = () => floatDecode();
    h.verdict = { use: false, cache: false };
    h.preview = embeddedJpeg;
    const photo = raw("B.ARW");

    await passesInNewSessions(photo, 3);
    const image = await (await session()).loadPhotoImage(photo);

    expect(h.decodes).toEqual(["pass", "pass"]);
    expect(image).toMatchObject({ kind: "bitmap", bitmap: { width: 6000, height: 4000 } });
  });

  // A marginal decode is never cached, so without a marker every pass would
  // decode it again. Develop still shows it, as it always has.
  it("skips a suspicious decode after two sessions marked it; Develop still shows it", async () => {
    h.decodeResult = () => floatDecode({ suspicious: true });
    const photo = raw("B.ARW");

    await passesInNewSessions(photo, 3);
    const image = await (await session()).loadPhotoImage(photo);

    expect(h.decodes).toEqual(["pass", "pass", "develop"]);
    expect(image).toMatchObject({ kind: "float", width: 4, height: 2 });
  });
});

// A RAW imported without a preview is retried by the repair on every open; one
// the decoder failed on for good would only fail again.
describe("the preview repair and a RAW the decoder can't use", () => {
  it("leaves it alone once two sessions failed on it", async () => {
    const photo = raw("B.ARW", { width: 0, height: 0 });
    await passesInNewSessions(photo, 2);

    await (await session()).repairMissingPreviews([photo]);

    expect(h.decodes).toEqual(["pass", "pass"]);
  });

  it("still tries it while one session's failure is all there is", async () => {
    const photo = raw("B.ARW", { width: 0, height: 0 });
    await passesInNewSessions(photo, 1);

    await (await session()).repairMissingPreviews([photo]);

    expect(h.decodes).toEqual(["pass", "pass"]);
  });
});

describe("Develop and a RAW the decoder can't use", () => {
  it("decodes again until a second session fails it, then shows the camera's preview", async () => {
    h.preview = embeddedJpeg;
    const photo = raw("B.ARW");

    const first = await session();
    await first.loadPhotoImage(photo);
    await first.loadPhotoImage(photo);
    await (await session()).loadPhotoImage(photo);
    const later = await (await session()).loadPhotoImage(photo);

    expect(h.decodes).toEqual(["develop", "develop", "develop"]);
    expect(later).toMatchObject({ kind: "bitmap", bitmap: { width: 6000, height: 4000 } });
  });

  it("leaves the photo to the Cache all pass from then on as well", async () => {
    const photo = raw("B.ARW");

    await (await session()).loadPhotoImage(photo);
    await (await session()).loadPhotoImage(photo);
    await passesInNewSessions(photo, 1);

    expect(h.decodes).toEqual(["develop", "develop"]);
  });
});
