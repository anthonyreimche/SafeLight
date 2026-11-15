// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What `slu` and the hidden engine say to each other. Requests go to the engine
// as JSON lines on stdin; events and image frames come back framed on stdout.

import type { DevelopParams } from "@/catalog/types";

export const ENGINE_PROTOCOL = 1;

export interface ProjectWire { root: string; workingDir: string; location: "in-folder" | "external" }
export interface LookOverride { params?: Partial<DevelopParams>; paramBag?: Record<string, unknown> }

export interface ExportWireSettings {
  format?: "jpg" | "png" | "tiff" | "webp";
  quality?: number;
  longEdge?: number | "original";
  colourSpace?: "srgb" | "display-p3" | "adobe-rgb" | "prophoto-rgb";
  bitDepth?: 8 | 16;
  nameTemplate?: string;
  existing?: "number" | "replace";
}

export type ExportTarget = { kind: "dir"; dir: string } | { kind: "file"; path: string } | { kind: "stdout" };

export type EngineRequest =
  | { id: number; type: "export"; project: ProjectWire; photoIds: string[]; settings: ExportWireSettings; target: ExportTarget; overrides?: LookOverride }
  | { id: number; type: "preview"; project: ProjectWire; photoId: string; width: number; height: number; encoding: "png" | "rgba"; overrides?: LookOverride }
  | { id: number; type: "shutdown" };

export interface EngineExtensionState { id: string; version: string; started: boolean; error?: string }

export type EngineEvent =
  | { id: 0; type: "ready"; protocol: number; appVersion: string; backend: string; software: boolean; extensions: EngineExtensionState[] }
  | { id: 0; type: "log"; level: "info" | "warn" | "error"; message: string }
  | { id: number; type: "progress"; done: number; total: number; photoId?: string }
  | { id: number; type: "exported"; photoId: string; path?: string; frame?: number; width: number; height: number; colourSpace: string; bytes: number }
  | { id: number; type: "frame"; frame: number; width: number; height: number; encoding: "png" | "rgba" }
  | { id: number; type: "error"; code: "decode" | "render" | "project" | "internal"; message: string; photoId?: string }
  | { id: number; type: "done" };

/** Wire on the engine's stdout: [u8 kind][u32le length][payload]. kind 0 = UTF-8 JSON EngineEvent,
 *  kind 1 = binary frame payload [u32le frame][bytes]. Requests go on stdin as JSON lines. */
export const WIRE_JSON = 0;
export const WIRE_FRAME = 1;

const HEADER = 5;

export function encodeWire(kind: 0 | 1, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER + payload.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, kind);
  view.setUint32(1, payload.length, true);
  out.set(payload, HEADER);
  return out;
}

export class WireDecoder {
  private pending: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): Array<{ kind: 0 | 1; payload: Uint8Array }> {
    let buf = chunk;
    if (this.pending.length > 0) {
      buf = new Uint8Array(this.pending.length + chunk.length);
      buf.set(this.pending, 0);
      buf.set(chunk, this.pending.length);
    }
    const out: Array<{ kind: 0 | 1; payload: Uint8Array }> = [];
    let at = 0;
    while (buf.length - at >= HEADER) {
      const view = new DataView(buf.buffer, buf.byteOffset + at, HEADER);
      const kind = view.getUint8(0);
      if (kind !== WIRE_JSON && kind !== WIRE_FRAME) throw new Error(`engine wire: unknown kind ${kind}`);
      const length = view.getUint32(1, true);
      if (buf.length - at - HEADER < length) break;
      // slice copies, so the caller's chunk can be reused after push returns
      out.push({ kind, payload: buf.slice(at + HEADER, at + HEADER + length) });
      at += HEADER + length;
    }
    this.pending = buf.slice(at);
    return out;
  }
}
