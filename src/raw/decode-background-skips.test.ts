// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What background decodes pass over for the rest of the session: a file libraw
// gave no answer for, and a file a decode is already under way for (it fills
// the cache itself). Such a request answers "transient" without asking libraw;
// a photo the user opens is still decoded. The answer says it passed the file
// over, so no caller takes a lesser image in its place. libraw is faked. Each test names its
// own files: what decode.ts remembers lasts the session, this file's run.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecodeFailure, RawFloatImage } from "./decode";

const h = vi.hoisted(() => ({
  /** The name of each file libraw was asked to decode, in order. */
  asked: [] as string[],
  /** What libraw answers each time; a pending promise holds the decode open. */
  answer: null as (() => Promise<RawFloatImage | DecodeFailure>) | null,
}));

vi.mock("./libraw-wasm-adapter", () => ({
  decodeRawFloatViaLibRaw: async (buffer: ArrayBuffer) => {
    h.asked.push(new TextDecoder().decode(buffer));
    if (!h.answer) throw new Error("no answer set");
    return h.answer();
  },
}));

import { decodeRawToFloat } from "./decode";

const raw = (name: string, lastModified = 1): File => new File([name], name, { lastModified });

const decoded = (): Promise<RawFloatImage> =>
  Promise.resolve({ data: new Float32Array(4), width: 1, height: 1 });

const noAnswer = (): Promise<DecodeFailure> =>
  Promise.resolve({ failure: "transient", timedOut: true });

/** A libraw decode held open until `finish` is called. */
function heldOpen(): { finish: () => void } {
  let finish = (): void => {};
  h.answer = () =>
    new Promise((resolve) => {
      finish = () => void decoded().then(resolve);
    });
  return { finish: () => finish() };
}

beforeEach(() => {
  h.asked = [];
  h.answer = decoded;
});

describe("decodeRawToFloat, background work and a file libraw gave no answer for", () => {
  it("answers transient without asking libraw again", async () => {
    h.answer = noAnswer;
    await decodeRawToFloat(raw("A.ARW"), { background: true });

    const again = await decodeRawToFloat(raw("A.ARW"), { background: true });

    expect(again).toEqual({
      failure: "transient",
      reason: "no answer earlier this session",
      passedOver: true,
    });
    expect(h.asked).toEqual(["A.ARW"]);
  });

  it("still asks libraw for a photo the user opens", async () => {
    h.answer = noAnswer;
    await decodeRawToFloat(raw("B.ARW"), { background: true });

    await decodeRawToFloat(raw("B.ARW"));

    expect(h.asked).toEqual(["B.ARW", "B.ARW"]);
  });

  it("remembers only a decode that ran out of time", async () => {
    h.answer = () => Promise.resolve({ failure: "transient" });
    await decodeRawToFloat(raw("C.ARW"), { background: true });

    await decodeRawToFloat(raw("C.ARW"), { background: true });

    expect(h.asked).toEqual(["C.ARW", "C.ARW"]);
  });

  it("tells a changed file apart by its modification time", async () => {
    h.answer = noAnswer;
    await decodeRawToFloat(raw("D.ARW", 1), { background: true });

    await decodeRawToFloat(raw("D.ARW", 2), { background: true });

    expect(h.asked).toEqual(["D.ARW", "D.ARW"]);
  });
});

describe("decodeRawToFloat, background work and a file being decoded already", () => {
  it("answers transient without asking libraw", async () => {
    const first = heldOpen();
    const running = decodeRawToFloat(raw("E.ARW"));
    await vi.waitFor(() => expect(h.asked).toHaveLength(1));
    h.answer = decoded;

    const second = await decodeRawToFloat(raw("E.ARW"), { background: true });
    first.finish();
    await running;

    expect(second).toEqual({
      failure: "transient",
      reason: "being decoded already",
      passedOver: true,
    });
    expect(h.asked).toEqual(["E.ARW"]);
  });

  it("still asks libraw for a photo the user opens", async () => {
    const first = heldOpen();
    const running = decodeRawToFloat(raw("F.ARW"), { background: true });
    await vi.waitFor(() => expect(h.asked).toHaveLength(1));
    h.answer = decoded;

    await decodeRawToFloat(raw("F.ARW"));
    first.finish();
    await running;

    expect(h.asked).toEqual(["F.ARW", "F.ARW"]);
  });

  it("asks again once every decode under way has finished", async () => {
    const first = heldOpen();
    const one = decodeRawToFloat(raw("G.ARW"));
    await vi.waitFor(() => expect(h.asked).toHaveLength(1));
    const second = heldOpen();
    const two = decodeRawToFloat(raw("G.ARW"));
    await vi.waitFor(() => expect(h.asked).toHaveLength(2));
    h.answer = decoded;

    first.finish();
    await one;
    const whileOneRuns = await decodeRawToFloat(raw("G.ARW"), { background: true });
    second.finish();
    await two;
    const afterBoth = await decodeRawToFloat(raw("G.ARW"), { background: true });

    expect(whileOneRuns).toEqual({
      failure: "transient",
      reason: "being decoded already",
      passedOver: true,
    });
    expect(afterBoth).toMatchObject({ width: 1, height: 1 });
    expect(h.asked).toEqual(["G.ARW", "G.ARW", "G.ARW"]);
  });
});
