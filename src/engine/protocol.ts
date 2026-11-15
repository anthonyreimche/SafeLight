// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What `slu` and the hidden engine say to each other, over one local socket.
// Requests go to the engine as JSON lines; events and image frames come back framed.

import type { DevelopParams } from "@/catalog/types";
import type { LockInfo, MovedPhoto } from "@/project/storage-options";

export const ENGINE_PROTOCOL = 2;

export interface ProjectWire { root: string; workingDir: string; location: "in-folder" | "external" }
export interface LookOverride { params?: Partial<DevelopParams>; paramBag?: Record<string, unknown> }
/** A window of the photo as shown (after its crop), each edge 0…1 of the whole. */
export interface PreviewRegion { x: number; y: number; w: number; h: number }

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

/** Which new files an import takes in, as paths from the project root ("" is the
 *  root itself). Every import follows moved photos and drops gone ones, whatever
 *  its scope. */
export type ImportScope =
  | { kind: "all" }
  | { kind: "some"; files: string[]; folders: { relPath: string; recursive: boolean }[] };

export type EngineRequest =
  | { id: number; type: "export"; project: ProjectWire; photoIds: string[]; settings: ExportWireSettings; target: ExportTarget; overrides?: LookOverride }
  /** `region` draws that window of the photo at width × height, as a zoomed Develop view does.
   *  `catalogue` is the catalogue file's stamp as `slu` last read it: one the engine didn't read
   *  the project at makes it read the project again, so a warm engine sees edits made since. */
  | { id: number; type: "preview"; project: ProjectWire; photoId: string; width: number; height: number; encoding: "png" | "rgba"; overrides?: LookOverride; region?: PreviewRegion; catalogue?: string }
  /** The one request that writes: the GUI's folder open, under the writer lock as `slu`. */
  | { id: number; type: "import"; project: { root: string }; scope: ImportScope; metadata: boolean; keepBackup: true }
  /** Each photo's stored grid preview, fitted inside edge × edge. */
  | { id: number; type: "thumbs"; project: ProjectWire; photoIds: string[]; edge: number; encoding: "png" | "rgba" }
  /** Stops request `target`, served at once rather than queued, and not answered:
   *  `target` ends on its own "done", after what it sent before it stopped. */
  | { id: number; type: "cancel"; target: number }
  | { id: number; type: "shutdown" };

export interface EngineExtensionState { id: string; version: string; started: boolean; error?: string }

export type EngineEvent =
  | { id: 0; type: "ready"; protocol: number; appVersion: string; backend: string; software: boolean; extensions: EngineExtensionState[] }
  | { id: 0; type: "log"; level: "info" | "warn" | "error"; message: string }
  | { id: number; type: "progress"; phase?: "files" | "camera-data"; done: number; total: number; photoId?: string }
  | { id: number; type: "exported"; photoId: string; path?: string; frame?: number; width: number; height: number; colourSpace: string; bytes: number }
  | { id: number; type: "frame"; frame: number; width: number; height: number; encoding: "png" | "rgba"; photoId?: string }
  | { id: number; type: "import-plan"; workingDir: string; location: "in-folder" | "external"; created: boolean; newFiles: number }
  | { id: number; type: "import-file"; relPath: string; photoId?: string; state: "ok" | "no-preview" | "failed"; error?: string }
  | { id: number; type: "import-done"; moved: MovedPhoto[]; dropped: ImportDrop[]; pending: number; stopped: null | "interrupted" | "safelight-opened" }
  /** `heldBy` comes with "locked": who holds the project's writer lock. */
  | { id: number; type: "error"; code: "decode" | "render" | "project" | "locked" | "internal"; message: string; photoId?: string; heldBy?: LockInfo }
  | { id: number; type: "done" };

/** A photo the import dropped because its file is gone, edits and all. */
export interface ImportDrop { id: string; relPath: string; edited: boolean }

/** Wire from the engine, on the local socket the CLI passes as --slu-pipe: [u8 kind][u32le length][payload].
 *  kind 0 = UTF-8 JSON EngineEvent, kind 1 = binary frame payload [u32le frame][bytes]. Requests go the
 *  other way on the same socket as JSON lines. */
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
    for (;;) {
      // Electron on Windows writes a bare CRLF to a piped stdout as it starts; no kind is 10 or 13.
      while (at < buf.length && (buf[at] === 0x0a || buf[at] === 0x0d)) at++;
      if (buf.length - at < HEADER) break;
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
