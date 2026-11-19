// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { WIRE_FRAME, WIRE_JSON, WireDecoder, encodeWire, type EngineEvent } from "./protocol";

const text = (s: string) => new TextEncoder().encode(s);
const json = (e: EngineEvent) => encodeWire(WIRE_JSON, text(JSON.stringify(e)));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

describe("engine wire", () => {
  it("frames a payload as kind, little-endian length, payload", () => {
    const wire = encodeWire(WIRE_FRAME, new Uint8Array([7, 8, 9]));
    expect([...wire]).toEqual([1, 3, 0, 0, 0, 7, 8, 9]);
  });

  it("decodes a message split across many chunks", () => {
    const done: EngineEvent = { id: 4, type: "done" };
    const wire = json(done);
    const decoder = new WireDecoder();
    const got = [];
    for (let i = 0; i < wire.length; i++) got.push(...decoder.push(wire.subarray(i, i + 1)));
    expect(got).toHaveLength(1);
    expect(got[0].kind).toBe(WIRE_JSON);
    expect(JSON.parse(new TextDecoder().decode(got[0].payload))).toEqual(done);
  });

  it("decodes two messages from one chunk and keeps the remainder", () => {
    const frame = encodeWire(WIRE_FRAME, new Uint8Array([1, 0, 0, 0, 255, 128]));
    const done = json({ id: 2, type: "done" });
    const wire = concat(frame, done, done.subarray(0, 3));
    const decoder = new WireDecoder();
    const first = decoder.push(wire);
    expect(first.map((m) => m.kind)).toEqual([WIRE_FRAME, WIRE_JSON]);
    expect([...first[0].payload]).toEqual([1, 0, 0, 0, 255, 128]);
    const rest = decoder.push(done.subarray(3));
    expect(rest).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(rest[0].payload))).toEqual({ id: 2, type: "done" });
  });

  it("decodes an empty payload", () => {
    const decoder = new WireDecoder();
    const got = decoder.push(encodeWire(WIRE_JSON, new Uint8Array(0)));
    expect(got).toHaveLength(1);
    expect(got[0].payload.length).toBe(0);
  });

  it("returns payloads that survive later pushes", () => {
    const decoder = new WireDecoder();
    const chunk = encodeWire(WIRE_FRAME, new Uint8Array([5, 6]));
    const [msg] = decoder.push(chunk);
    chunk.fill(0);
    decoder.push(encodeWire(WIRE_FRAME, new Uint8Array([9, 9])));
    expect([...msg.payload]).toEqual([5, 6]);
  });

  // Electron on Windows writes a bare CRLF to a piped stdout as it starts.
  it("skips line breaks between messages", () => {
    const done = json({ id: 1, type: "done" });
    const decoder = new WireDecoder();
    expect(decoder.push(new Uint8Array([0x0d, 0x0a]))).toEqual([]);
    const got = decoder.push(concat(done, new Uint8Array([0x0a]), done));
    expect(got).toHaveLength(2);
    expect(got.every((m) => m.kind === WIRE_JSON)).toBe(true);
  });

  it("rejects an unknown kind", () => {
    const decoder = new WireDecoder();
    expect(() => decoder.push(new Uint8Array([9, 0, 0, 0, 0]))).toThrow(/kind/);
  });
});
