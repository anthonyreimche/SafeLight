// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A float decode the user abandoned does no more work than it has to: it
// doesn't read the file once the request is gone, and it doesn't fall back to
// the in-house decoder when libraw dropped it. libraw is faked; the in-house
// path is the real one, counted where it starts parsing the file.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** Each request handed to libraw, in order. */
  requests: [] as ({ background?: boolean; signal?: AbortSignal } | undefined)[],
  /** Runs while libraw "waits" for an instance, before it answers null. */
  whileWaiting: (): void => {},
  /** How many times the in-house decoder started parsing a file. */
  inHouse: 0,
  /** What libraw answers for a request abandoned while it was out. */
  answerOnceAbandoned: "aborted" as "aborted" | "unsupported",
}));

vi.mock("./libraw-wasm-adapter", () => ({
  decodeRawFloatViaLibRaw: async (
    _buffer: ArrayBuffer,
    request?: { background?: boolean; signal?: AbortSignal },
  ) => {
    h.requests.push(request);
    h.whileWaiting();
    return { failure: request?.signal?.aborted ? h.answerOnceAbandoned : ("transient" as const) };
  },
}));

vi.mock("./tiff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tiff")>();
  return {
    ...actual,
    TiffReader: class extends actual.TiffReader {
      constructor(buffer: ArrayBuffer, base?: number) {
        h.inHouse++;
        super(buffer, base);
      }
    },
  };
});

import { decodeRawToFloat } from "./decode";

beforeEach(() => {
  h.requests = [];
  h.whileWaiting = () => {};
  h.inHouse = 0;
  h.answerOnceAbandoned = "aborted";
});

describe("decodeRawToFloat for a request the user abandoned", () => {
  it("reads nothing from a file whose request was already abandoned", async () => {
    const file = new Blob(["raw"]);
    const read = vi.spyOn(file, "arrayBuffer");
    const gone = new AbortController();
    gone.abort();

    const image = await decodeRawToFloat(file, { signal: gone.signal });

    expect(image).toEqual({ failure: "aborted" });
    expect(read).not.toHaveBeenCalled();
    expect(h.requests).toEqual([]);
  });

  it("hands the signal on to libraw along with the priority", async () => {
    const opened = new AbortController();

    await decodeRawToFloat(new Blob(["raw"]), { background: true, signal: opened.signal });

    expect(h.requests).toEqual([{ background: true, signal: opened.signal }]);
  });

  // libraw drops a request abandoned while it waited for an instance. One
  // abandoned while it ran may have failed for real, but nobody is waiting to
  // learn that, and a later request will find out again.
  it.each([
    ["dropped it", "aborted"],
    ["failed on it", "unsupported"],
  ] as const)(
    "answers aborted, skipping the in-house decoder, once libraw %s as it was abandoned",
    async (_, answer) => {
      h.answerOnceAbandoned = answer;
      await decodeRawToFloat(new Blob(["raw"]));
      expect(h.inHouse).toBe(1);

      const opened = new AbortController();
      h.whileWaiting = () => opened.abort();
      const image = await decodeRawToFloat(new Blob(["raw"]), { signal: opened.signal });

      expect(image).toEqual({ failure: "aborted" });
      expect(h.inHouse).toBe(1);
    },
  );
});
