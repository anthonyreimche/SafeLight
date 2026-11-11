// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The frame worker's client. The worker is faked by running the real handler
// on structured clones, so a buffer handed over is detached here as it is in a
// browser.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFrame, handleFrameRequest, toSrgb8, type FrameJob, type FrameRequest } from "./frame-job";
import { answerFrameRequest, linearizeCodes, type ProfileJob } from "./profile-frame";

class FakeWorker {
  static all: FakeWorker[] = [];
  /** Messages sit unanswered until answerNext(). */
  static hold = false;
  /** postMessage refuses, as a browser does a value it can't clone. */
  static refuse = false;
  static terminated = 0;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  readonly queue: FrameRequest[] = [];

  constructor() {
    FakeWorker.all.push(this);
  }

  postMessage(msg: FrameRequest, transfer: Transferable[]): void {
    if (FakeWorker.refuse) throw new DOMException("could not be cloned", "DataCloneError");
    this.queue.push(structuredClone(msg, { transfer }));
    if (!FakeWorker.hold) this.answerNext();
  }

  answerNext(): void {
    const req = this.queue.shift();
    if (!req) throw new Error("nothing to answer");
    const send = ({ reply, transfer }: ReturnType<typeof handleFrameRequest>) => {
      const data = structuredClone(reply, { transfer });
      setTimeout(() => this.onmessage?.({ data }));
    };
    if (req.op === "profile") void answerFrameRequest(req).then(send);
    else send(handleFrameRequest(req));
  }

  terminate(): void {
    FakeWorker.terminated++;
  }
}

async function load() {
  vi.resetModules();
  return import("./frame-bridge");
}

function job(): FrameJob {
  const pixels = Uint16Array.from({ length: 5 * 3 * 3 }, (_, i) => (i * 4099) % 65536);
  return { pixels, width: 5, height: 3, stride: 3, gain: 1.5, turn: 90, foveon: false, cacheEdge: 4 };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  FakeWorker.all = [];
  FakeWorker.hold = false;
  FakeWorker.refuse = false;
  FakeWorker.terminated = 0;
  vi.stubGlobal("Worker", FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("finishFrame through the worker", () => {
  it("returns the frame and cache entry the inline conversion gives, bit for bit", async () => {
    const { finishFrame } = await load();

    const viaWorker = await finishFrame(job());

    expect(FakeWorker.all).toHaveLength(1);
    expect(viaWorker).toEqual(buildFrame(job()));
    expect(viaWorker).toHaveProperty("entry");
  });

  it("hands the samples over without a copy", async () => {
    const { finishFrame } = await load();
    const j = job();

    await finishFrame(j);

    expect(j.pixels.buffer.byteLength).toBe(0);
  });

  it("passes a rejected frame through", async () => {
    const { finishFrame } = await load();
    const pixels = new Uint16Array(200 * 100 * 3).fill(65535);
    pixels.fill(20000, 0);
    for (let p = 0; p < 200 * 100; p++) pixels[p * 3] = 65535;

    const out = await finishFrame({ ...job(), pixels, width: 200, height: 100, gain: 3, turn: 0 });

    expect(out).toEqual({ rejected: expect.stringMatching(/blown\+imbalanced/) });
  });

  it("answers an inline conversion where there is no Worker", async () => {
    vi.stubGlobal("Worker", undefined);
    const { finishFrame } = await load();
    const j = job();

    const out = await finishFrame(j);

    expect(out).toEqual(buildFrame(job()));
    expect(j.pixels.buffer.byteLength).toBeGreaterThan(0);
  });

  it("converts inline, with the samples intact, when the worker won't take the message", async () => {
    FakeWorker.refuse = true;
    const { finishFrame } = await load();
    const j = job();

    const first = await finishFrame(j);
    await finishFrame(job());

    expect(first).toEqual(buildFrame(job()));
    expect(j.pixels.buffer.byteLength).toBeGreaterThan(0);
    expect(FakeWorker.all).toHaveLength(1);
  });

  it("fails the call a worker error caught, then converts inline", async () => {
    FakeWorker.hold = true;
    const { finishFrame } = await load();
    const failing = finishFrame(job());
    await settle();

    FakeWorker.all[0].onerror?.({ message: "boom" });

    await expect(failing).rejects.toThrow(/boom/);
    FakeWorker.hold = false;
    expect(await finishFrame(job())).toEqual(buildFrame(job()));
    expect(FakeWorker.all).toHaveLength(1);
    expect(FakeWorker.terminated).toBe(1);
  });

  it("rejects with the message of a conversion that threw", async () => {
    const { finishFrame } = await load();

    await expect(finishFrame({ ...job(), pixels: null as never })).rejects.toThrow(TypeError);
  });
});

describe("finishFrame's workers", () => {
  it("keeps an opened photo's conversion from waiting behind background ones", async () => {
    FakeWorker.hold = true;
    const { finishFrame } = await load();

    const background1 = finishFrame(job(), { background: true });
    const background2 = finishFrame(job(), { background: true });
    const interactive = finishFrame(job());
    await settle();

    // One worker is kept free of background work, so the opened photo's goes
    // straight in, ahead of the second background one.
    expect(FakeWorker.all.map((w) => w.queue.length)).toEqual([1, 1]);
    FakeWorker.all[1].answerNext();
    await interactive;
    FakeWorker.all[0].answerNext();
    await background1;
    await settle();
    expect(FakeWorker.all.reduce((sum, w) => sum + w.queue.length, 0)).toBe(1);
    FakeWorker.hold = false;
    FakeWorker.all.find((w) => w.queue.length)?.answerNext();
    await background2;
  });

  it("drops a waiting conversion whose decode was abandoned, unsent", async () => {
    FakeWorker.hold = true;
    const { finishFrame } = await load();
    const first = finishFrame(job());
    const second = finishFrame(job());
    const gone = new AbortController();
    const abandoned = finishFrame(job(), { signal: gone.signal });
    await settle();

    gone.abort();

    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    for (const w of FakeWorker.all) w.answerNext();
    await Promise.all([first, second]);
    await settle();
    expect(FakeWorker.all.reduce((sum, w) => sum + w.queue.length, 0)).toBe(0);
  });

  it("refuses a conversion whose decode was abandoned before it was asked for", async () => {
    const { finishFrame } = await load();
    const gone = new AbortController();
    gone.abort();

    await expect(finishFrame(job(), { signal: gone.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeWorker.all).toHaveLength(0);
  });

  it("lets a running conversion finish when its decode is abandoned", async () => {
    FakeWorker.hold = true;
    const { finishFrame } = await load();
    const gone = new AbortController();
    const running = finishFrame(job(), { signal: gone.signal });
    await settle();

    gone.abort();
    FakeWorker.all[0].answerNext();

    expect(await running).toEqual(buildFrame(job()));
  });
});

describe("encodeSrgb8", () => {
  it("encodes in the worker as toSrgb8 does inline", async () => {
    const { encodeSrgb8 } = await load();
    const data = Float32Array.from([-1, 0.001, 0.18, 1, 2, 0.5, 0.25, 1]);

    const bytes = await encodeSrgb8(data);

    expect(bytes).toEqual(toSrgb8(Float32Array.from([-1, 0.001, 0.18, 1, 2, 0.5, 0.25, 1])));
    expect(data.buffer.byteLength).toBe(0);
  });
});

/** A 3 × 2 photo's RGBA8 codes, as the image decoder hands them over. */
const CODES = Uint8ClampedArray.from({ length: 3 * 2 * 4 }, (_, i) => (i * 37) % 256);

/** Fakes the decode a profile job reads its codes through: every blob decodes
 *  to CODES, and each decode's options are kept. */
function stubCodeDecoder(): ImageBitmapOptions[] {
  const asked: ImageBitmapOptions[] = [];
  vi.stubGlobal("createImageBitmap", async (_src: Blob, opts: ImageBitmapOptions) => {
    asked.push(opts);
    return { width: 3, height: 2, close() {} };
  });
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      getContext() {
        return { drawImage() {}, getImageData: () => ({ data: CODES.slice() }) };
      }
    },
  );
  return asked;
}

function profileJob(over: Partial<ProfileJob> = {}): ProfileJob {
  return {
    source: new Blob(["png"]),
    decoder: "browser",
    transform: {
      trc: [Float32Array.from([0, 1]), Float32Array.from([0, 0.25, 1]), Float32Array.from([-0.5, 2])],
      toRec709: [1.2, -0.2, 0, 0, 1, 0, 0, -0.1, 1.1],
    },
    turn: 90,
    ...over,
  };
}

describe("convertInputFrame", () => {
  it("returns the halves the inline conversion gives, decoded without colour management", async () => {
    const asked = stubCodeDecoder();
    const { convertInputFrame } = await load();
    const job = profileJob();

    const frame = await convertInputFrame(job);

    expect(FakeWorker.all).toHaveLength(1);
    expect(frame).toEqual(linearizeCodes(CODES, 3, 2, job.transform, 90));
    expect(asked).toEqual([{ colorSpaceConversion: "none", imageOrientation: "none" }]);
  });

  it("leaves the transform with the resolver, which may keep it", async () => {
    stubCodeDecoder();
    const { convertInputFrame } = await load();
    const job = profileJob();

    await convertInputFrame(job);

    expect(job.transform.trc.map((t) => t.length)).toEqual([2, 3, 2]);
  });

  it("averages down to the target edge", async () => {
    stubCodeDecoder();
    const { convertInputFrame } = await load();

    const frame = await convertInputFrame(profileJob({ turn: 0, targetEdge: 2 }));

    expect([frame.width, frame.height]).toEqual([2, 1]);
  });

  it("converts inline where there is no Worker", async () => {
    stubCodeDecoder();
    vi.stubGlobal("Worker", undefined);
    const { convertInputFrame } = await load();
    const job = profileJob();

    expect(await convertInputFrame(job)).toEqual(linearizeCodes(CODES, 3, 2, job.transform, 90));
  });

  it("rejects when the file can't be decoded", async () => {
    stubCodeDecoder();
    vi.stubGlobal("createImageBitmap", async () => {
      throw new Error("corrupt");
    });
    const { convertInputFrame } = await load();

    await expect(convertInputFrame(profileJob())).rejects.toThrow("corrupt");
  });

  it("refuses a conversion abandoned before it was asked for", async () => {
    stubCodeDecoder();
    const { convertInputFrame } = await load();
    const gone = new AbortController();
    gone.abort();

    await expect(convertInputFrame(profileJob(), { signal: gone.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
