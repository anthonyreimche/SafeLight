// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// One extension turns non-RAW photos into linear Rec.709. Core holds its
// resolver, counts the changes that make a converted source stale, and asks it
// behind a guard: whatever it does wrong leaves the photo to the browser.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "./types";
import type { InputProfileResolver, InputTransform } from "@/extensions/api/develop";
import {
  dropInputProfiles,
  expectedInputProfileOwner,
  inputProfileKey,
  inputProfileOwner,
  inputProfileRevision,
  inputTransformProblem,
  invalidateInputProfiles,
  convertedTargetEdge,
  onInputProfilesChanged,
  registerInputProfiles,
  resolveInputTransform,
  RESOLVE_TIMEOUT_MS,
} from "./input-profiles";

const transform = (n = 2): InputTransform => ({
  trc: [new Float32Array(n), new Float32Array(n), new Float32Array(n)].map((t) => {
    for (let i = 0; i < n; i++) t[i] = i / (n - 1);
    return t;
  }) as InputTransform["trc"],
  toRec709: [1, 0, 0, 0, 1, 0, 0, 0, 1],
});

const resolver = (answer: () => Promise<InputTransform | null>): InputProfileResolver => ({
  resolve: vi.fn(answer),
});

const photo = (over: Partial<CatalogPhoto> = {}): CatalogPhoto =>
  ({ id: "p1", filename: "IMG_0001.JPG", rotation: 0, ...over }) as CatalogPhoto;

const file = new Blob(["jpeg"]);

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  const owner = inputProfileOwner();
  if (owner) dropInputProfiles(owner);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("inputProfileKey", () => {
  it("adds nothing while no resolver is held, whatever the token", () => {
    expect(inputProfileKey(photo())).toBe("");
    expect(inputProfileKey(photo({ inputProfile: "assign:p3" }))).toBe("");
  });

  it("changes with the revision and with the token while one is", () => {
    registerInputProfiles("com.a", resolver(async () => null));
    const first = inputProfileKey(photo());
    const tokened = inputProfileKey(photo({ inputProfile: "assign:p3" }));
    invalidateInputProfiles("com.a");
    const moved = inputProfileKey(photo());

    expect(new Set(["", first, tokened, moved]).size).toBe(4);
  });

  it("adds nothing again once the resolver has gone", () => {
    registerInputProfiles("com.a", resolver(async () => null));
    dropInputProfiles("com.a");

    expect(inputProfileKey(photo())).toBe("");
  });
});

describe("registerInputProfiles", () => {
  it("holds one extension's resolver and moves the revision", () => {
    const before = inputProfileRevision();
    registerInputProfiles("com.a", resolver(async () => null));

    expect(inputProfileOwner()).toBe("com.a");
    expect(inputProfileRevision()).toBe(before + 1);
  });

  it("refuses a second extension with a warning naming the owner", () => {
    const held = resolver(async () => transform());
    registerInputProfiles("com.a", held);
    const before = inputProfileRevision();

    registerInputProfiles("com.b", resolver(async () => null));

    expect(inputProfileOwner()).toBe("com.a");
    expect(inputProfileRevision()).toBe(before);
    expect(String(warn.mock.calls[0]?.[0])).toContain("com.a");
  });

  it("lets the owner replace its resolver", async () => {
    registerInputProfiles("com.a", resolver(async () => null));
    const before = inputProfileRevision();
    const next = resolver(async () => transform());

    registerInputProfiles("com.a", next);

    expect(inputProfileRevision()).toBe(before + 1);
    expect(await resolveInputTransform(photo(), file)).not.toBeNull();
    expect(next.resolve).toHaveBeenCalledOnce();
  });

  it("refuses something without a resolve function", () => {
    registerInputProfiles("com.a", {} as InputProfileResolver);

    expect(inputProfileOwner()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

describe("expectedInputProfileOwner", () => {
  beforeEach(() => {
    const items = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is null until an extension has registered", () => {
    expect(expectedInputProfileOwner()).toBeNull();
  });

  it("remembers the last owner for the next launch, after it stops too", () => {
    registerInputProfiles("com.a", resolver(async () => null));
    dropInputProfiles("com.a");

    expect(expectedInputProfileOwner()).toBe("com.a");
  });

  it("isn't taken over by a refused registration", () => {
    registerInputProfiles("com.a", resolver(async () => null));
    registerInputProfiles("com.b", resolver(async () => null));

    expect(expectedInputProfileOwner()).toBe("com.a");
  });
});

describe("dropInputProfiles and invalidateInputProfiles", () => {
  it("drops the owner's resolver and moves the revision; another's drop does nothing", () => {
    registerInputProfiles("com.a", resolver(async () => null));
    const before = inputProfileRevision();

    dropInputProfiles("com.b");
    expect(inputProfileOwner()).toBe("com.a");
    expect(inputProfileRevision()).toBe(before);

    dropInputProfiles("com.a");
    expect(inputProfileOwner()).toBeNull();
    expect(inputProfileRevision()).toBe(before + 1);
  });

  it("moves the revision for the owner only", () => {
    registerInputProfiles("com.a", resolver(async () => null));
    const before = inputProfileRevision();

    invalidateInputProfiles("com.b");
    expect(inputProfileRevision()).toBe(before);
    expect(warn).toHaveBeenCalled();

    invalidateInputProfiles("com.a");
    expect(inputProfileRevision()).toBe(before + 1);
  });

  it("tells its listeners of every move, until they stop listening", () => {
    const heard = vi.fn();
    const stop = onInputProfilesChanged(heard);

    registerInputProfiles("com.a", resolver(async () => null));
    invalidateInputProfiles("com.a");
    dropInputProfiles("com.a");
    stop();
    registerInputProfiles("com.a", resolver(async () => null));

    expect(heard).toHaveBeenCalledTimes(3);
  });
});

describe("resolveInputTransform", () => {
  it("answers null with no resolver, asking nothing", async () => {
    expect(await resolveInputTransform(photo(), file)).toBeNull();
  });

  it("asks the resolver about the photo's id, name and token, with its file", async () => {
    const held = resolver(async () => transform());
    registerInputProfiles("com.a", held);

    await resolveInputTransform(
      photo({ inputProfile: "assign:p3", fileHandle: {} as FileSystemFileHandle }),
      file,
    );

    expect(held.resolve).toHaveBeenCalledWith(
      { id: "p1", filename: "IMG_0001.JPG", inputProfile: "assign:p3" },
      file,
    );
  });

  // The transform is posted to the frame worker: anything else on the
  // resolver's object (a method) would fail the structured clone and send the
  // whole conversion onto the main thread.
  it("hands back a valid transform's tables and matrix alone", async () => {
    const t = transform(256);
    registerInputProfiles("com.a", resolver(async () => ({ ...t, describe: () => "P3" })));

    const got = await resolveInputTransform(photo(), file);

    expect(got).toEqual(t);
    expect(Object.keys(got!)).toEqual(["trc", "toRec709"]);
    expect(() => structuredClone(got)).not.toThrow();
  });

  it("answers null when the resolver throws, rejects or answers null", async () => {
    registerInputProfiles("com.a", {
      resolve: () => {
        throw new Error("boom");
      },
    });
    expect(await resolveInputTransform(photo(), file)).toBeNull();

    registerInputProfiles("com.a", resolver(() => Promise.reject(new Error("no"))));
    expect(await resolveInputTransform(photo(), file)).toBeNull();

    registerInputProfiles("com.a", resolver(async () => null));
    expect(await resolveInputTransform(photo(), file)).toBeNull();
  });

  it("answers null when the resolver takes longer than its time limit", async () => {
    vi.useFakeTimers();
    registerInputProfiles("com.a", resolver(() => new Promise(() => {})));

    const answer = resolveInputTransform(photo(), file);
    await vi.advanceTimersByTimeAsync(RESOLVE_TIMEOUT_MS);

    expect(await answer).toBeNull();
    expect(RESOLVE_TIMEOUT_MS).toBe(3000);
  });

  it("answers null, with a warning, for an invalid transform", async () => {
    registerInputProfiles("com.a", resolver(async () => ({ trc: [], toRec709: [] }) as unknown as InputTransform));

    expect(await resolveInputTransform(photo(), file)).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

describe("inputTransformProblem", () => {
  const nan = transform();
  nan.trc[1][0] = NaN;
  const ragged = transform();
  ragged.trc[2] = new Float32Array(3);

  it.each([
    ["null", null],
    ["no trc", { toRec709: [1, 0, 0, 0, 1, 0, 0, 0, 1] }],
    ["two tables", { ...transform(), trc: transform().trc.slice(0, 2) }],
    ["a table that isn't a Float32Array", { ...transform(), trc: [[0, 1], [0, 1], [0, 1]] }],
    ["one sample", transform(1)],
    ["more than 65536 samples", transform(65537)],
    ["tables of different lengths", ragged],
    ["a NaN sample", nan],
    ["an infinite sample", { ...transform(), trc: [new Float32Array([0, Infinity]), ...transform().trc.slice(1)] }],
    ["eight matrix entries", { ...transform(), toRec709: [1, 0, 0, 0, 1, 0, 0, 0] }],
    ["a NaN matrix entry", { ...transform(), toRec709: [1, 0, 0, 0, NaN, 0, 0, 0, 1] }],
    ["a matrix entry that isn't a number", { ...transform(), toRec709: [1, 0, 0, 0, "1", 0, 0, 0, 1] }],
  ])("refuses %s", (_name, value) => {
    expect(inputTransformProblem(value)).toEqual(expect.any(String));
  });

  it.each([2, 4096, 65536])("takes %i samples", (n) => {
    expect(inputTransformProblem(transform(n))).toBeNull();
  });

  it("takes negative and above-one samples", () => {
    const wide = transform();
    wide.trc[0][0] = -0.25;
    wide.trc[0][1] = 4;
    expect(inputTransformProblem(wide)).toBeNull();
  });
});

describe("convertedTargetEdge", () => {
  it("asks a non-RAW photo's conversion to stop at the edge", () => {
    expect(convertedTargetEdge(photo(), 1280)).toEqual({ targetEdge: 1280 });
    expect(convertedTargetEdge(photo({ filename: "SCAN.TIFF" }), 640)).toEqual({ targetEdge: 640 });
  });

  it("leaves a RAW's decode as it was", () => {
    expect(convertedTargetEdge(photo({ filename: "DSC_0001.NEF" }), 1280)).toEqual({});
  });
});
