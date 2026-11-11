// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// An edited thumbnail is drawn from the photo's converted source, so it goes
// stale when the conversion changes: for the photos whose token changed, and
// for every edited non-RAW photo when the resolver comes, goes or says its
// answers changed. A RAW's source never depends on it, and a plain preview is
// the browser's decode either way.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto, DevelopParams } from "@/catalog/types";
import { freshParams } from "@/catalog/types";

const h = vi.hoisted(() => ({
  photos: [] as CatalogPhoto[],
  settled: true,
  setInputProfile: vi.fn(async (_ids: string[], _token: string | null) => {}),
  redrawn: [] as { id: string; params: DevelopParams; asShot: number; bag?: Record<string, unknown> }[],
}));

vi.mock("./catalog-store", () => ({
  useCatalogStore: { getState: () => ({ photos: h.photos, setInputProfile: h.setInputProfile }) },
}));
vi.mock("./edited-thumbnail", () => ({
  regenerateEditedThumbnail: async (
    id: string,
    params: DevelopParams,
    asShot: number,
    bag?: Record<string, unknown>,
  ) => {
    h.redrawn.push({ id, params, asShot, bag });
  },
}));
vi.mock("@/catalog/edit-params", () => ({
  loadSavedEdit: async (id: string, asShot?: number) => ({
    params: { ...freshParams(asShot), exposure: id.length },
    paramBag: { [`x.${id}`]: 1 },
  }),
}));
vi.mock("@/extensions/loader", () => ({
  useExternalPluginsSettled: { getState: () => ({ settled: h.settled }) },
}));

import {
  dropInputProfiles,
  invalidateInputProfiles,
  registerInputProfiles,
} from "@/catalog/input-profiles";
import { redrawEditedThumbnails, setInputProfiles, watchInputProfiles } from "./input-profile-redraw";

const shot = (id: string, filename: string, over: Partial<CatalogPhoto> = {}): CatalogPhoto =>
  ({ id, filename, exif: {}, rotation: 0, ...over }) as CatalogPhoto;

const settle = () => new Promise((r) => setTimeout(r, 0));

let stop = () => {};

beforeEach(() => {
  h.photos = [
    shot("a", "A.JPG", { previewEdit: "e1" }),
    shot("b", "B.PNG"),
    shot("c", "C.NEF", { previewEdit: "e2" }),
    shot("d", "D.TIF", { previewEdit: "e3", exif: { colorTemperature: 5200 } }),
  ];
  h.settled = true;
  h.redrawn = [];
  h.setInputProfile.mockClear();
});

afterEach(() => {
  stop();
  dropInputProfiles("ext.p");
});

describe("redrawEditedThumbnails", () => {
  it("draws again the edited non-RAW photos named, with their saved edit", async () => {
    await redrawEditedThumbnails(["a", "b", "c"]);

    expect(h.redrawn.map((r) => r.id)).toEqual(["a"]);
    expect(h.redrawn[0]).toMatchObject({ asShot: 6500, bag: { "x.a": 1 }, params: { exposure: 1 } });
  });

  it("draws every edited non-RAW photo when none are named, at its as-shot white balance", async () => {
    await redrawEditedThumbnails();

    expect(h.redrawn.map((r) => [r.id, r.asShot])).toEqual([
      ["a", 6500],
      ["d", 5200],
    ]);
  });
});

describe("setInputProfiles", () => {
  it("stores the token, then draws those photos again", async () => {
    await setInputProfiles(["a", "d"], "assign:p3");

    expect(h.setInputProfile).toHaveBeenCalledWith(["a", "d"], "assign:p3");
    expect(h.redrawn.map((r) => r.id)).toEqual(["a", "d"]);
  });
});

describe("watchInputProfiles", () => {
  it("draws every edited non-RAW photo again when the resolver comes, changes or goes", async () => {
    stop = watchInputProfiles();

    registerInputProfiles("ext.p", { resolve: async () => null });
    await settle();
    expect(h.redrawn.map((r) => r.id)).toEqual(["a", "d"]);

    h.redrawn = [];
    invalidateInputProfiles("ext.p");
    await settle();
    expect(h.redrawn.map((r) => r.id)).toEqual(["a", "d"]);

    h.redrawn = [];
    dropInputProfiles("ext.p");
    await settle();
    expect(h.redrawn.map((r) => r.id)).toEqual(["a", "d"]);
  });

  it("draws nothing for a resolver registered while the extensions start", async () => {
    stop = watchInputProfiles();
    h.settled = false;

    registerInputProfiles("ext.p", { resolve: async () => null });
    await settle();

    expect(h.redrawn).toEqual([]);
  });

  it("draws once for changes that come together", async () => {
    stop = watchInputProfiles();

    registerInputProfiles("ext.p", { resolve: async () => null });
    invalidateInputProfiles("ext.p");
    await settle();

    expect(h.redrawn.map((r) => r.id)).toEqual(["a", "d"]);
  });
});
