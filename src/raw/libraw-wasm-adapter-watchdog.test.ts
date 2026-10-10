// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A libraw call that fails with an error, or never answers, gives its instance
// back to the pool as a fresh one. A rejected call (a trap, an abort) leaves the
// module unusable; a hung one is given up on after decodeTimeLimit. Either way
// the decode answers "transient": nothing is struck against the photo. The pool
// is the real one; libraw's instances are faked, and time is fake.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Call {
  instance: number;
  call: "open" | "metadata" | "imageData";
}

const h = vi.hoisted(() => ({
  made: 0,
  /** Every call made on an instance, in order. */
  calls: [] as Call[],
  /** The instances whose worker was ended. */
  ended: [] as number[],
  /** What each call answers; a never-settling promise is a hang. */
  open: (): Promise<void> => Promise.resolve(),
  metadata: (): Promise<Record<string, unknown> | undefined> =>
    Promise.resolve({ width: 2, height: 2, color_data: { cam_mul: [1, 1, 1, 1] } }),
  imageData: (): Promise<unknown> => Promise.resolve(new Uint16Array(2 * 2 * 3).fill(12000)),
}));

vi.mock("libraw-wasm", () => ({
  default: class {
    readonly id = ++h.made;
    worker = { terminate: () => void h.ended.push(this.id) };
    open(): Promise<void> {
      h.calls.push({ instance: this.id, call: "open" });
      return h.open();
    }
    metadata(): Promise<Record<string, unknown> | undefined> {
      h.calls.push({ instance: this.id, call: "metadata" });
      return h.metadata();
    }
    imageData(): Promise<unknown> {
      h.calls.push({ instance: this.id, call: "imageData" });
      return h.imageData();
    }
  },
}));

import {
  decodeRawFloatViaLibRaw,
  decodeTimeLimit,
  decodeTimeLimitForFrame,
  extractRawMetadata,
} from "./libraw-wasm-adapter";
import { decodePoolSize, disposeDecodePool } from "./decode-pool";

const SIZE = 2 * 1024 * 1024;
const rawBytes = (): ArrayBuffer => new ArrayBuffer(SIZE);
const never = <T>(): Promise<T> => new Promise<T>(() => {});

/** What a decode given up on at its time limit answers. */
const NO_ANSWER = {
  failure: "transient",
  reason: expect.stringMatching(/^decode error: no answer within \d+ s$/),
  timedOut: true,
};

/** Settles `call` into a readable state without waiting on it forever. */
function track<T>(call: Promise<T>): { result?: T; settled: boolean } {
  const state: { result?: T; settled: boolean } = { settled: false };
  void call.then((result) => {
    state.result = result;
    state.settled = true;
  });
  return state;
}

/** The instance that took the first call. */
const firstOpened = (): number => h.calls[0].instance;

/** The calls made on one instance, in order. */
const callsOn = (instance: number): string[] =>
  h.calls.filter((c) => c.instance === instance).map((c) => c.call);

beforeEach(() => {
  h.made = 0;
  h.calls = [];
  h.ended = [];
  h.open = () => Promise.resolve();
  h.metadata = () =>
    Promise.resolve({ width: 2, height: 2, color_data: { cam_mul: [1, 1, 1, 1] } });
  h.imageData = () => Promise.resolve(new Uint16Array(2 * 2 * 3).fill(12000));
  vi.useFakeTimers();
  vi.stubGlobal("Worker", class {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  disposeDecodePool();
});

afterEach(() => {
  disposeDecodePool();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("decodeTimeLimit", () => {
  it("allows a minute, plus 20 s for every 25 MB of RAW", () => {
    expect(decodeTimeLimit(0)).toBe(60_000);
    expect(decodeTimeLimit(25_000_000)).toBe(80_000);
    expect(decodeTimeLimit(100_000_000)).toBe(140_000);
  });
});

describe("decodeRawFloatViaLibRaw on an instance that fails", () => {
  it("answers transient for a call that rejects, and the instance is replaced", async () => {
    h.open = () => Promise.reject("RuntimeError: unreachable");

    const failed = await decodeRawFloatViaLibRaw(rawBytes());

    expect(failed).toEqual({
      failure: "transient",
      reason: "decode error: RuntimeError: unreachable",
    });
    expect(failed).not.toHaveProperty("timedOut");

    expect(h.ended).toEqual([firstOpened()]);
    expect(decodePoolSize()).toBe(3);
    h.open = () => Promise.resolve();
    const next = await Promise.all([1, 2, 3].map(() => decodeRawFloatViaLibRaw(rawBytes())));
    expect(next).toEqual(Array(3).fill(expect.objectContaining({ width: 2, height: 2 })));
    expect(callsOn(firstOpened())).toEqual(["open"]);
  });

  it("gives up on a call that never answers at the limit, and answers transient", async () => {
    h.open = never;
    const decoding = track(decodeRawFloatViaLibRaw(rawBytes()));

    await vi.advanceTimersByTimeAsync(decodeTimeLimit(SIZE) - 1);
    expect(decoding.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(decoding.result).toEqual(NO_ANSWER);
    expect(h.ended).toEqual([firstOpened()]);
  });

  it("frees the slot of a hung decode: the next decodes run on a replacement", async () => {
    h.open = never;
    const hung = [1, 2, 3].map(() => track(decodeRawFloatViaLibRaw(rawBytes())));
    await vi.advanceTimersByTimeAsync(0);
    h.open = () => Promise.resolve();
    const next = track(decodeRawFloatViaLibRaw(rawBytes()));

    await vi.advanceTimersByTimeAsync(decodeTimeLimit(SIZE));
    await vi.advanceTimersByTimeAsync(0);

    expect(hung.map((d) => d.result)).toEqual(Array(3).fill(NO_ANSWER));
    expect(next.result).toMatchObject({ width: 2, height: 2 });
    expect(h.ended.sort()).toEqual([1, 2, 3]);
    expect(decodePoolSize()).toBe(3);
  });

  it("watches metadata and imageData as well as open", async () => {
    h.metadata = never;
    const onMetadata = track(decodeRawFloatViaLibRaw(rawBytes()));
    await vi.advanceTimersByTimeAsync(decodeTimeLimit(SIZE));
    expect(onMetadata.result).toEqual(NO_ANSWER);

    h.metadata = () =>
      Promise.resolve({ width: 2, height: 2, color_data: { cam_mul: [1, 1, 1, 1] } });
    h.imageData = never;
    const onPixels = track(decodeRawFloatViaLibRaw(rawBytes()));
    await vi.advanceTimersByTimeAsync(decodeTimeLimit(SIZE));
    expect(onPixels.result).toEqual(NO_ANSWER);
    expect(h.ended).toHaveLength(2);
  });

  it("ignores a late answer from the worker it gave up on", async () => {
    let answerLate = (): void => {};
    h.open = () => new Promise<void>((resolve) => (answerLate = resolve));
    const decoding = track(decodeRawFloatViaLibRaw(rawBytes()));
    await vi.advanceTimersByTimeAsync(decodeTimeLimit(SIZE));

    answerLate();
    await vi.advanceTimersByTimeAsync(0);
    h.open = () => Promise.resolve();
    await Promise.all([1, 2, 3].map(() => decodeRawFloatViaLibRaw(rawBytes())));

    expect(decoding.result).toEqual(NO_ANSWER);
    expect(callsOn(firstOpened())).toEqual(["open"]);
  });
});

describe("decodeRawFloatViaLibRaw and its timer", () => {
  it("answers aborted for an abandoned request and leaves no timer behind", async () => {
    const gone = new AbortController();
    gone.abort();

    expect(await decodeRawFloatViaLibRaw(rawBytes(), { signal: gone.signal })).toEqual({
      failure: "aborted",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer of a decode that finishes, abandoned midway or not", async () => {
    const opened = new AbortController();
    h.open = () => {
      opened.abort();
      return Promise.resolve();
    };

    const image = await decodeRawFloatViaLibRaw(rawBytes(), { signal: opened.signal });

    expect(image).toMatchObject({ width: 2, height: 2 });
    expect(vi.getTimerCount()).toBe(0);
    expect(h.ended).toEqual([]);
  });
});

// Demosaicing scales with pixels, not bytes: a lossy 61 MP file is small for
// its work. open() only reads the header and unpacking waits for imageData(),
// so the limit can grow once metadata() has told the frame.
describe("decodeTimeLimitForFrame", () => {
  it("allows a minute, plus 2 s per megapixel: three minutes for 61 MP", () => {
    expect(decodeTimeLimitForFrame(0, 0)).toBe(60_000);
    expect(decodeTimeLimitForFrame(1_000, 1_000)).toBe(62_000);
    expect(decodeTimeLimitForFrame(9_504, 6_336)).toBeGreaterThanOrEqual(180_000);
  });

  it("stops at five minutes, whatever frame a header claims", () => {
    expect(decodeTimeLimitForFrame(40_000, 30_000)).toBe(300_000);
  });
});

describe("decodeRawFloatViaLibRaw's limit once the frame is known", () => {
  const frame61MP = { width: 9_504, height: 6_336, color_data: { cam_mul: [1, 1, 1, 1] } };

  it("gives a small file of many megapixels the frame's longer limit", async () => {
    h.metadata = () => Promise.resolve(frame61MP);
    h.imageData = never;
    const decoding = track(decodeRawFloatViaLibRaw(rawBytes()));

    await vi.advanceTimersByTimeAsync(decodeTimeLimitForFrame(9_504, 6_336) - 1);
    expect(decoding.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(decoding.result).toEqual(NO_ANSWER);
    expect(decodeTimeLimit(SIZE)).toBeLessThan(decodeTimeLimitForFrame(9_504, 6_336));
  });

  it("counts the frame's limit from the start of the decode, not from metadata()", async () => {
    h.metadata = () => new Promise((resolve) => setTimeout(() => resolve(frame61MP), 30_000));
    h.imageData = never;
    const decoding = track(decodeRawFloatViaLibRaw(rawBytes()));

    await vi.advanceTimersByTimeAsync(decodeTimeLimitForFrame(9_504, 6_336) - 1);
    expect(decoding.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(decoding.result).toEqual(NO_ANSWER);
  });

  it("never shortens the limit a large file already has", async () => {
    const large = new ArrayBuffer(25_000_000);
    h.imageData = never;
    const decoding = track(decodeRawFloatViaLibRaw(large));

    await vi.advanceTimersByTimeAsync(decodeTimeLimit(large.byteLength) - 1);
    expect(decoding.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(decoding.result).toEqual(NO_ANSWER);
    expect(decodeTimeLimitForFrame(2, 2)).toBeLessThan(decodeTimeLimit(large.byteLength));
  });

  it("gives a header claiming 40000×30000 no more than five minutes", async () => {
    h.metadata = () =>
      Promise.resolve({ width: 40_000, height: 30_000, color_data: { cam_mul: [1, 1, 1, 1] } });
    h.imageData = never;
    const decoding = track(decodeRawFloatViaLibRaw(rawBytes()));

    await vi.advanceTimersByTimeAsync(300_000 - 1);
    expect(decoding.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(decoding.result).toEqual(NO_ANSWER);
  });

  it("clears the longer limit's timer when the decode finishes, abandoned midway", async () => {
    const opened = new AbortController();
    h.metadata = () => {
      opened.abort();
      return Promise.resolve(frame61MP);
    };
    h.imageData = () => Promise.resolve({ data: new Uint16Array(2 * 2 * 3), width: 2, height: 2 });

    await decodeRawFloatViaLibRaw(rawBytes(), { signal: opened.signal });

    expect(vi.getTimerCount()).toBe(0);
  });
});

// LibRaw's own C++ errors reach JS as an empty answer, so metadata() can
// resolve undefined. That gives no frame to lengthen the limit by.
describe("decodeRawFloatViaLibRaw when metadata() answers nothing", () => {
  it("is unsupported when nothing else answers either", async () => {
    h.open = () => Promise.resolve();
    h.metadata = () => Promise.resolve(undefined);
    h.imageData = () => Promise.resolve(undefined);

    expect(await decodeRawFloatViaLibRaw(rawBytes())).toEqual({
      failure: "unsupported",
      reason: "imageData returned undefined (WASM error)",
    });
  });

  it("still takes the pixels imageData() hands back", async () => {
    h.metadata = () => Promise.resolve(undefined);
    h.imageData = () =>
      Promise.resolve({ data: new Uint16Array(2 * 2 * 3).fill(12000), width: 2, height: 2 });

    expect(await decodeRawFloatViaLibRaw(rawBytes())).toMatchObject({ width: 2, height: 2 });
  });

  it("keeps the byte limit", async () => {
    h.metadata = () => Promise.resolve(undefined);
    h.imageData = never;
    const decoding = track(decodeRawFloatViaLibRaw(rawBytes()));

    await vi.advanceTimersByTimeAsync(decodeTimeLimit(SIZE) - 1);
    expect(decoding.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(decoding.result).toEqual(NO_ANSWER);
  });
});

describe("the [libraw] decoded log line", () => {
  it("says how long the decode took", async () => {
    h.imageData = () =>
      new Promise((resolve) =>
        setTimeout(() => resolve(new Uint16Array(2 * 2 * 3).fill(12000)), 4_200),
      );
    const decoding = decodeRawFloatViaLibRaw(rawBytes());

    await vi.advanceTimersByTimeAsync(4_200);
    await decoding;

    expect(vi.mocked(console.log)).toHaveBeenCalledWith(
      "[libraw] decoded",
      expect.any(String),
      "in 4.2 s",
    );
  });
});

describe("extractRawMetadata on an instance that hangs", () => {
  it("answers no metadata at the limit and the instance is replaced", async () => {
    h.open = never;
    const reading = track(extractRawMetadata(rawBytes()));

    await vi.advanceTimersByTimeAsync(decodeTimeLimit(SIZE));

    expect(reading.settled).toBe(true);
    expect(reading.result).toBeUndefined();
    expect(h.ended).toEqual([firstOpened()]);
  });
});
