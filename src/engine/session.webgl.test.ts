// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The engine's preview through the real render bridge and worker, with the
// Essentials' stages registered: its RGBA is the frame the renderer captures
// of the same look at the same size, byte for byte.

import { afterAll, describe, expect, it } from "vitest";
import type { DecodedImage } from "@/catalog/load-image";
import type { CatalogStorage } from "@/catalog/storage";
import type { CatalogPhoto } from "@/catalog/types";
import { registerProcessingStage } from "@/extensions/registry";
import { disposeRenderBridge, getRenderBridge } from "@/rendering/render-bridge";
import { essentialStages } from "@/rendering/webgl/essential-stages.fixtures";
import { useDevelopStore } from "@/state/develop-store";
import type { PortMessage, RequestOut } from "./rpc";
import { EngineSession, encodeFrame } from "./session";

const W = 64;
const H = 40;

function scene(): DecodedImage {
  const data = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const v = 0.02 + (x / (W - 1)) * 0.6;
      data.set([v, v * (0.7 + (0.3 * y) / H), v * 0.85, 1], o);
    }
  }
  return { kind: "float", data, width: W, height: H };
}

const PHOTO: CatalogPhoto = {
  id: "p1",
  filename: "p1.ARW",
  relPath: "p1.ARW",
  folder: "",
  directoryHandle: null,
  fileHandle: { kind: "file", name: "p1.ARW" } as unknown as FileSystemFileHandle,
  thumbnailBlob: null,
  thumbnailUrl: null,
  width: W,
  height: H,
  fileSize: 1,
  mimeType: "image/x-sony-arw",
  rating: 0,
  colorLabel: "none",
  flag: "none",
  rotation: 0,
  keywords: [],
  dateCreated: 0,
  dateImported: 0,
  exif: { colorTemperature: 5000 },
};

const storage: CatalogStorage = {
  putPhoto: async () => {},
  putPhotos: async () => {},
  deletePhotos: async () => {},
  getEditState: async () => undefined,
  putEditState: async () => {},
  putEditStates: async () => {},
};

afterAll(() => disposeRenderBridge());

describe("an engine preview on the real renderer", () => {
  it("is the frame a capture of the same look draws, at the same size", async () => {
    for (const stage of essentialStages()) registerProcessingStage(stage.extensionId, stage);
    const engine = new EngineSession({
      openProject: async () => ({ photos: [PHOTO], storage }),
      loadImage: async () => scene(),
    });
    const sent: PortMessage[] = [];
    const out: RequestOut = {
      emit: (event) => sent.push(event),
      frame: (bytes, announce) => sent.push(announce(1), { frame: 1, bytes }),
    };

    await engine.preview(
      {
        id: 1,
        type: "preview",
        project: { root: "/shoot", workingDir: "/shoot/.safelight", location: "in-folder" },
        photoId: PHOTO.id,
        width: W,
        height: H,
        encoding: "rgba",
        overrides: { params: { exposure: 0.7, contrast: 25, saturation: -20, temperature: 6200 } },
      },
      out,
    );

    const announced = sent.find((m) => "type" in m && m.type === "frame");
    expect(announced).toMatchObject({ width: W, height: H, encoding: "rgba" });
    const preview = sent.find((m): m is { frame: number; bytes: Uint8Array } => "bytes" in m);
    if (!preview) throw new Error("no frame bytes");

    const { params } = useDevelopStore.getState();
    expect(params.exposure).toBe(0.7);
    const captured = await encodeFrame(await getRenderBridge().capture(params), W, H, "rgba");

    expect(captured.width).toBe(W);
    expect(preview.bytes.length).toBe(W * H * 4);
    let differing = 0;
    preview.bytes.forEach((v, i) => {
      if (v !== captured.bytes[i]) differing++;
    });
    expect(differing).toBe(0);
    // Not a blank frame that would match any other blank frame.
    expect(new Set(preview.bytes).size).toBeGreaterThan(16);
  }, 120_000);
});
