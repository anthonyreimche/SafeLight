// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BroadcastMessage } from "./broadcast";
import type { CatalogPhoto, EditState } from "@/catalog/types";
import type { CatalogStorage } from "@/catalog/storage";

const h = vi.hoisted(() => ({
  broadcasts: [] as BroadcastMessage[],
  openLast: vi.fn(async (): Promise<void> => {}),
  reconnectLast: vi.fn(async (): Promise<boolean> => true),
  metadata: [] as {
    photos: CatalogPhoto[];
    getEditState: (id: string) => Promise<EditState | null>;
  }[],
  removals: [] as { id: string; fileName: string }[],
}));

// Cross-window fan-out is a side effect here; capture the messages instead so the
// sync contract (echo guards, origin stamps) stays assertable without a channel.
vi.mock("./broadcast", () => ({
  broadcast: (message: BroadcastMessage) => void h.broadcasts.push(message),
  onBroadcast: () => () => {},
  WINDOW_ID: "test-window",
}));

vi.mock("@/project/project-store", () => ({
  useProjectStore: {
    getState: () => ({ openLast: h.openLast, reconnectLast: h.reconnectLast }),
  },
}));

vi.mock("@/extensions/registry", () => ({
  emitMetadataChange: async (ctx: (typeof h.metadata)[number]) => {
    h.metadata.push(ctx);
  },
  emitPhotoRemove: async (ctx: { photo: CatalogPhoto; fileName: string }) => {
    h.removals.push({ id: ctx.photo.id, fileName: ctx.fileName });
  },
}));

// Rotation bakes pixels through an OffscreenCanvas; a tagged blob stands in so the
// store's blob/URL swap stays observable. normalizeRotation is pure — keep it real.
vi.mock("@/catalog/orient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/catalog/orient")>()),
  rotateBlob: async (blob: Blob, deg: number) => new Blob([`${await blob.text()}+${deg}`]),
}));

import { setCatalogStorage } from "@/catalog/storage";
import { useCatalogStore } from "./catalog-store";

function memoryCatalogStorage() {
  const rows = new Map<string, CatalogPhoto>();
  const edits = new Map<string, EditState>();
  const storage: CatalogStorage = {
    getAllPhotos: async () => [...rows.values()],
    putPhoto: async (p) => void rows.set(p.id, p),
    putPhotos: async (list) => {
      for (const p of list) rows.set(p.id, p);
    },
    deletePhoto: async (id) => void rows.delete(id),
    getEditState: async (id) => edits.get(id),
    getAllEditStates: async () => [...edits.values()],
    putEditState: async (e) => void edits.set(e.photoId, e),
  };
  return { storage, rows, edits };
}

const dirHandle = { name: "trip" } as unknown as FileSystemDirectoryHandle;
const fileHandle = (name: string) => ({ name }) as unknown as FileSystemFileHandle;

function photo(id: string, over: Partial<CatalogPhoto> = {}): CatalogPhoto {
  return {
    id,
    filename: `${id}.NEF`,
    relPath: `trip/${id}.NEF`,
    folder: "trip",
    directoryHandle: dirHandle,
    fileHandle: fileHandle(`${id}.NEF`),
    thumbnailBlob: null,
    thumbnailUrl: null,
    width: 6000,
    height: 4000,
    fileSize: 25_000_000,
    mimeType: "image/x-nikon-nef",
    rating: 0,
    colorLabel: "none",
    flag: "none",
    rotation: 0,
    keywords: [],
    dateCreated: 1_700_000_000,
    dateImported: 1_700_000_100,
    exif: {},
    ...over,
  };
}

type PreviewedPhoto = CatalogPhoto & { thumbnailBlob: Blob; thumbnailUrl: string };

/** A photo carrying a live preview, as the grid loader leaves it. */
function previewed(id: string, over: Partial<CatalogPhoto> = {}): PreviewedPhoto {
  const thumbnailBlob = new Blob([id]);
  return {
    ...photo(id, over),
    thumbnailBlob,
    thumbnailUrl: URL.createObjectURL(thumbnailBlob),
  };
}

let urlSeq = 0;
const liveUrls = new Set<string>();
let store: ReturnType<typeof memoryCatalogStorage>;

const state = () => useCatalogStore.getState();
const ids = () => state().photos.map((p) => p.id);
const selected = () => [...state().selectedIds];

beforeEach(() => {
  urlSeq = 0;
  liveUrls.clear();
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
    const url = `blob:test/${urlSeq++}`;
    liveUrls.add(url);
    return url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => void liveUrls.delete(url));

  h.broadcasts.length = 0;
  h.metadata.length = 0;
  h.removals.length = 0;
  h.openLast.mockReset();
  h.reconnectLast.mockReset();

  store = memoryCatalogStorage();
  setCatalogStorage(store.storage);
  useCatalogStore.setState({
    photos: [],
    selectedIds: new Set(),
    activePhotoId: null,
    loading: false,
    fileAccessNonce: 0,
    needsReconnect: false,
    reconnecting: false,
  });
});

afterEach(() => {
  setCatalogStorage(null);
  vi.restoreAllMocks();
});

describe("opening a project", () => {
  it("replaceCatalog swaps the list and revokes the previews it drops", () => {
    const old = previewed("old");
    useCatalogStore.setState({
      photos: [old],
      selectedIds: new Set(["old"]),
      activePhotoId: "old",
      needsReconnect: true,
    });

    state().replaceCatalog([photo("a")]);

    expect(ids()).toEqual(["a"]);
    expect(selected()).toEqual([]);
    expect(state().activePhotoId).toBeNull();
    expect(state().needsReconnect).toBe(false);
    expect(liveUrls.has(old.thumbnailUrl)).toBe(false);
  });

  it("appendPhotos adds records without disturbing the selection", () => {
    useCatalogStore.setState({ photos: [photo("a")], selectedIds: new Set(["a"]), activePhotoId: "a" });

    state().appendPhotos([photo("b"), photo("c")]);

    expect(ids()).toEqual(["a", "b", "c"]);
    expect(selected()).toEqual(["a"]);
    expect(state().activePhotoId).toBe("a");
  });

  it("finalizeCatalog keeps the previews built during the progressive open", () => {
    const shown = previewed("a");
    useCatalogStore.setState({ photos: [shown] });

    state().finalizeCatalog([shown]);

    // Same object references as those already on screen — revoking would blank them.
    expect(liveUrls.has(shown.thumbnailUrl)).toBe(true);
  });

  it("reconcileCatalog carries skeleton previews onto the rescanned records", () => {
    const skeleton = previewed("a");
    useCatalogStore.setState({ photos: [skeleton] });

    state().reconcileCatalog([photo("a", { fileHandle: fileHandle("a.NEF") }), photo("b")]);

    expect(ids()).toEqual(["a", "b"]);
    expect(state().photos[0].thumbnailUrl).toBe(skeleton.thumbnailUrl);
    expect(state().photos[0].thumbnailBlob).toBe(skeleton.thumbnailBlob);
    expect(liveUrls.has(skeleton.thumbnailUrl)).toBe(true);
  });

  it("reconcileCatalog forgets photos that vanished from disk", () => {
    const gone = previewed("gone");
    useCatalogStore.setState({
      photos: [photo("a"), gone],
      selectedIds: new Set(["a", "gone"]),
      activePhotoId: "gone",
    });

    state().reconcileCatalog([photo("a")]);

    expect(ids()).toEqual(["a"]);
    expect(selected()).toEqual(["a"]);
    expect(state().activePhotoId).toBeNull();
    expect(liveUrls.has(gone.thumbnailUrl)).toBe(false);
  });
});

describe("addPhotos", () => {
  it("persists the records before showing them", async () => {
    await state().addPhotos([photo("a")]);

    expect(store.rows.has("a")).toBe(true);
    expect(ids()).toEqual(["a"]);
  });

  it("inserts each record right after the given photo", async () => {
    useCatalogStore.setState({ photos: [photo("a"), photo("b")] });

    await state().addPhotos([photo("a-copy"), photo("a-copy-2")], { afterId: "a" });

    expect(ids()).toEqual(["a", "a-copy", "a-copy-2", "b"]);
  });

  it("appends when the anchor is not in the catalog", async () => {
    useCatalogStore.setState({ photos: [photo("a")] });

    await state().addPhotos([photo("b")], { afterId: "missing" });

    expect(ids()).toEqual(["a", "b"]);
  });

  it("does nothing at all for an empty list", async () => {
    await state().addPhotos([]);

    expect(store.rows.size).toBe(0);
    expect(h.broadcasts).toEqual([]);
  });
});

describe("previews", () => {
  it("mergeThumbnails only fills in photos that have no preview yet", async () => {
    const held = previewed("held");
    useCatalogStore.setState({ photos: [photo("bare"), held] });
    const existing = held.thumbnailUrl;

    state().mergeThumbnails([
      { id: "bare", blob: new Blob(["bare"]) },
      { id: "held", blob: new Blob(["ignored"]) },
      { id: "absent", blob: new Blob(["absent"]) },
    ]);

    const [bare, kept] = state().photos;
    expect(await bare.thumbnailBlob?.text()).toBe("bare");
    expect(liveUrls.has(bare.thumbnailUrl ?? "")).toBe(true);
    // Overwriting a live preview would strand its object URL.
    expect(kept.thumbnailUrl).toBe(existing);
    expect(kept.thumbnailBlob).toBe(held.thumbnailBlob);
    // An update for a photo that isn't in the catalog adds nothing.
    expect(ids()).toEqual(["bare", "held"]);
  });

  it("updatePhoto revokes the preview it supersedes and stamps the origin window", () => {
    const before = previewed("a");
    useCatalogStore.setState({ photos: [before] });
    const after = previewed("a", { rating: 3 });

    state().updatePhoto(after);

    expect(state().photos[0]).toBe(after);
    expect(liveUrls.has(before.thumbnailUrl)).toBe(false);
    expect(liveUrls.has(after.thumbnailUrl)).toBe(true);
    expect(h.broadcasts).toEqual([
      { type: "catalog-change", payload: { action: "update", id: "a", origin: "test-window" } },
    ]);
  });

  it("updatePhoto keeps a preview the replacement still points at", () => {
    const before = previewed("a");
    useCatalogStore.setState({ photos: [before] });

    state().updatePhoto({ ...before, rating: 5 });

    expect(liveUrls.has(before.thumbnailUrl)).toBe(true);
  });

  it("replaceThumbnail swaps in a reloaded preview without re-broadcasting", () => {
    const before = previewed("a");
    useCatalogStore.setState({ photos: [before] });
    const reloaded = new Blob(["reloaded"]);

    state().replaceThumbnail("a", reloaded);

    expect(state().photos[0].thumbnailBlob).toBe(reloaded);
    expect(liveUrls.has(before.thumbnailUrl)).toBe(false);
    // Reacting to another window's broadcast — echoing it back would loop.
    expect(h.broadcasts).toEqual([]);
  });
});

describe("removal", () => {
  it("takes a master's virtual copies with it", async () => {
    const list = [
      photo("a"),
      photo("a-c1", { copyOf: "a" }),
      photo("a-c2", { copyOf: "a" }),
      photo("b"),
    ];
    await store.storage.putPhotos(list);
    useCatalogStore.setState({ photos: list });

    await state().removePhoto("a");

    expect(ids()).toEqual(["b"]);
    expect([...store.rows.keys()]).toEqual(["b"]);
  });

  it("removes a virtual copy on its own without touching its master", async () => {
    useCatalogStore.setState({ photos: [photo("a"), photo("a-c1", { copyOf: "a" })] });

    await state().removePhoto("a-c1");

    expect(ids()).toEqual(["a"]);
  });

  it("prunes the selection and drops the active highlight", async () => {
    useCatalogStore.setState({
      photos: [photo("a"), photo("b"), photo("c")],
      selectedIds: new Set(["a", "b"]),
      activePhotoId: "b",
    });

    await state().removePhotos(["b"]);

    expect(ids()).toEqual(["a", "c"]);
    expect(selected()).toEqual(["a"]);
    expect(state().activePhotoId).toBeNull();
  });

  it("keeps an active photo that survives the removal", async () => {
    useCatalogStore.setState({
      photos: [photo("a"), photo("b")],
      selectedIds: new Set(["a", "b"]),
      activePhotoId: "a",
    });

    await state().removePhotos(["b"]);

    expect(state().activePhotoId).toBe("a");
  });

  it("deletes the records from storage", async () => {
    useCatalogStore.setState({ photos: [photo("a"), photo("b")] });
    await store.storage.putPhotos([photo("a"), photo("b")]);

    await state().removePhotos(["a"]);

    expect([...store.rows.keys()]).toEqual(["b"]);
  });

  it("releases the previews of the photos it drops", async () => {
    const a = previewed("a");
    const b = previewed("b");
    useCatalogStore.setState({ photos: [a, b] });

    await state().removePhotos(["a"]);

    expect(liveUrls.has(a.thumbnailUrl)).toBe(false);
    expect(liveUrls.has(b.thumbnailUrl)).toBe(true);
  });

  it("tells extensions which file each removed photo owned", async () => {
    useCatalogStore.setState({
      photos: [photo("a"), photo("orphan", { directoryHandle: null, fileHandle: null })],
    });

    await state().removePhotos(["a", "orphan"]);

    // A record with no live handles has no sidecar to clean up.
    expect(h.removals).toEqual([{ id: "a", fileName: "a.NEF" }]);
  });

  it("is a no-op for an empty id list", async () => {
    useCatalogStore.setState({ photos: [photo("a")] });

    await state().removePhotos([]);

    expect(ids()).toEqual(["a"]);
    expect(h.broadcasts).toEqual([]);
  });
});

describe("rating, label and flag", () => {
  beforeEach(() => {
    useCatalogStore.setState({ photos: [photo("a"), photo("b"), photo("c")] });
  });

  it("writes a single photo's rating through to storage", async () => {
    await state().setRating("b", 4);

    expect(state().photos.map((p) => p.rating)).toEqual([0, 4, 0]);
    expect(store.rows.get("b")?.rating).toBe(4);
  });

  it("sets the colour label and flag", async () => {
    await state().setColorLabel("a", "red");
    await state().setFlag("a", "reject");

    expect(state().photos[0].colorLabel).toBe("red");
    expect(state().photos[0].flag).toBe("reject");
    expect(store.rows.get("a")?.flag).toBe("reject");
  });

  it("applies a culling verdict to a whole multi-selection in one write", async () => {
    await state().applyFlag(["a", "c"], "pick");

    expect(state().photos.map((p) => p.flag)).toEqual(["pick", "none", "pick"]);
    expect(h.broadcasts).toEqual([
      { type: "catalog-change", payload: { action: "update", id: undefined } },
    ]);
  });

  it("batch-applies ratings and labels", async () => {
    await state().applyRating(["a", "b"], 5);
    await state().applyColorLabel(["a", "b"], "green");

    expect(state().photos.map((p) => p.rating)).toEqual([5, 5, 0]);
    expect(state().photos.map((p) => p.colorLabel)).toEqual(["green", "green", "none"]);
  });

  it("ignores ids that are not in the catalog", async () => {
    await state().applyRating(["ghost"], 5);

    expect(store.rows.size).toBe(0);
    expect(h.broadcasts).toEqual([]);
  });

  it("hands extensions the post-mutation records and a null edit state when none is stored", async () => {
    await state().setRating("a", 2);

    const [ctx] = h.metadata;
    expect(ctx.photos.map((p) => [p.id, p.rating])).toEqual([["a", 2]]);
    await expect(ctx.getEditState("a")).resolves.toBeNull();
  });
});

describe("keywords", () => {
  beforeEach(() => {
    useCatalogStore.setState({
      photos: [photo("a", { keywords: ["sky"] }), photo("b", { keywords: [] })],
    });
  });

  it("adds a keyword once, however often it is applied", async () => {
    await state().addKeyword("a", "dawn");
    await state().addKeyword("a", "dawn");

    expect(state().photos[0].keywords).toEqual(["sky", "dawn"]);
  });

  it("removes a keyword and leaves the rest in order", async () => {
    await state().addKeyword("a", "dawn");
    await state().removeKeyword("a", "sky");

    expect(state().photos[0].keywords).toEqual(["dawn"]);
  });

  it("adds only the missing keywords across a selection", async () => {
    await state().addKeywords(["a", "b"], ["sky", "sea"]);

    expect(state().photos[0].keywords).toEqual(["sky", "sea"]);
    expect(state().photos[1].keywords).toEqual(["sky", "sea"]);
    expect(store.rows.get("a")?.keywords).toEqual(["sky", "sea"]);
  });

  it("strips keywords from a selection, ignoring photos that lack them", async () => {
    await state().addKeywords(["a", "b"], ["sea"]);
    await state().removeKeywords(["a", "b"], ["sky"]);

    expect(state().photos[0].keywords).toEqual(["sea"]);
    expect(state().photos[1].keywords).toEqual(["sea"]);
  });
});

describe("rotatePhotos", () => {
  it("bakes the turn into the preview and swaps the stored dimensions", async () => {
    const a = previewed("a");
    useCatalogStore.setState({ photos: [a] });

    await state().rotatePhotos(["a"], 90);

    const rotated = state().photos[0];
    expect(rotated.rotation).toBe(90);
    expect(rotated.width).toBe(4000);
    expect(rotated.height).toBe(6000);
    expect(await rotated.thumbnailBlob!.text()).toBe("a+90");
    expect(liveUrls.has(a.thumbnailUrl)).toBe(false);
    expect(liveUrls.has(rotated.thumbnailUrl as string)).toBe(true);
    expect(store.rows.get("a")?.rotation).toBe(90);
  });

  it("accumulates turns and keeps the angle in 0–359", async () => {
    useCatalogStore.setState({ photos: [photo("a", { rotation: 270 })] });

    await state().rotatePhotos(["a"], 180);

    expect(state().photos[0].rotation).toBe(90);
  });

  it("normalises a negative turn into its positive equivalent", async () => {
    useCatalogStore.setState({ photos: [photo("a")] });

    await state().rotatePhotos(["a"], -90);

    expect(state().photos[0].rotation).toBe(270);
    expect(state().photos[0].width).toBe(4000);
  });

  it("leaves 180° dimensions alone", async () => {
    useCatalogStore.setState({ photos: [photo("a")] });

    await state().rotatePhotos(["a"], 180);

    expect([state().photos[0].width, state().photos[0].height]).toEqual([6000, 4000]);
  });

  it("skips a whole turn and a nonsense angle", async () => {
    useCatalogStore.setState({ photos: [photo("a")] });

    await state().rotatePhotos(["a"], 360);
    await state().rotatePhotos(["a"], Number.NaN);

    expect(state().photos[0].rotation).toBe(0);
    expect(store.rows.size).toBe(0);
  });
});

describe("relocatePhotos and setCopyName", () => {
  it("persists the new paths of photos that moved on disk", async () => {
    useCatalogStore.setState({ photos: [photo("a"), photo("b")] });
    const moved = { ...photo("a"), relPath: "archive/a.NEF", folder: "archive" };

    await state().relocatePhotos([moved]);

    expect(state().photos[0].folder).toBe("archive");
    expect(store.rows.get("a")?.relPath).toBe("archive/a.NEF");
  });

  it("trims a virtual copy's display name and clears it when blank", async () => {
    useCatalogStore.setState({ photos: [photo("a-c1", { copyOf: "a" })] });

    await state().setCopyName("a-c1", "  dusk grade  ");
    expect(state().photos[0].copyName).toBe("dusk grade");

    await state().setCopyName("a-c1", "   ");
    expect(state().photos[0].copyName).toBeUndefined();
    expect(store.rows.get("a-c1")?.copyName).toBeUndefined();
  });

  it("ignores a copy-name change for an unknown photo", async () => {
    await state().setCopyName("ghost", "x");

    expect(store.rows.size).toBe(0);
  });
});

describe("selection", () => {
  beforeEach(() => {
    useCatalogStore.setState({
      photos: [photo("a"), photo("b"), photo("c"), photo("d")],
    });
  });

  it("select replaces the selection and moves the active highlight", () => {
    state().select("b");
    state().select("c");

    expect(selected()).toEqual(["c"]);
    expect(state().activePhotoId).toBe("c");
  });

  it("toggleSelect adds and removes one photo at a time", () => {
    state().toggleSelect("a");
    state().toggleSelect("c");
    expect(selected()).toEqual(["a", "c"]);
    expect(state().activePhotoId).toBe("c");

    state().toggleSelect("a");
    expect(selected()).toEqual(["c"]);
    expect(state().activePhotoId).toBe("c");
  });

  it("hands the active highlight to a still-selected photo when the active one is dropped", () => {
    state().toggleSelect("a");
    state().toggleSelect("b");

    state().toggleSelect("b");

    expect(selected()).toEqual(["a"]);
    expect(state().activePhotoId).toBe("a");
  });

  it("clears the active highlight when the last selected photo is dropped", () => {
    state().toggleSelect("a");
    state().toggleSelect("a");

    expect(selected()).toEqual([]);
    expect(state().activePhotoId).toBeNull();
  });

  it("selectRange spans the order the user sees, not catalog order", () => {
    state().select("d");
    // The grid is sorted the other way round; the run must follow that view.
    state().selectRange("b", ["d", "c", "b", "a"]);

    expect(selected().sort()).toEqual(["b", "c", "d"]);
  });

  it("selectRange works backwards from the anchor", () => {
    state().select("c");
    state().selectRange("a");

    expect(selected().sort()).toEqual(["a", "b", "c"]);
  });

  it("selectRange leaves the anchor put, so the next shift-click spans from it again", () => {
    state().select("b");
    state().selectRange("d");

    expect(state().activePhotoId).toBe("b");
    expect(selected().sort()).toEqual(["b", "c", "d"]);
  });

  it("selectRange extends a ctrl-click selection instead of replacing it", () => {
    state().toggleSelect("a");
    state().toggleSelect("c");
    state().selectRange("d");

    expect(selected().sort()).toEqual(["a", "c", "d"]);
  });

  it("selectRange with no anchor falls back to selecting the clicked photo", () => {
    state().selectRange("c");

    expect(selected()).toEqual(["c"]);
    expect(state().activePhotoId).toBe("c");
  });

  it("selectRange does nothing when either end is outside the visible order", () => {
    state().select("a");
    state().selectRange("c", ["c", "d"]); // anchor "a" is filtered out of the view

    expect(selected()).toEqual(["a"]);
  });

  it("selectAll takes the visible ids, or the whole catalog when given none", () => {
    state().selectAll(["b", "c"]);
    expect(selected()).toEqual(["b", "c"]);

    state().selectAll();
    expect(selected()).toEqual(["a", "b", "c", "d"]);
  });

  it("deselectAll clears the selection and the active highlight", () => {
    state().select("a");
    state().deselectAll();

    expect(selected()).toEqual([]);
    expect(state().activePhotoId).toBeNull();
  });
});

describe("setActivePhoto", () => {
  it("announces a local change to the other windows", () => {
    state().setActivePhoto("a");

    expect(state().activePhotoId).toBe("a");
    expect(h.broadcasts).toEqual([
      { type: "selection-change", payload: { activePhotoId: "a" } },
    ]);
  });

  it("never re-broadcasts a change that arrived from another window", () => {
    // Echoing it lets two windows ping-pong between interleaved ids forever.
    state().setActivePhoto("a", { broadcast: false });

    expect(state().activePhotoId).toBe("a");
    expect(h.broadcasts).toEqual([]);
  });

  it("stays quiet when the id is already active", () => {
    state().setActivePhoto("a");
    h.broadcasts.length = 0;

    state().setActivePhoto("a");

    expect(h.broadcasts).toEqual([]);
  });

  it("clears the highlight without announcing an empty selection", () => {
    state().setActivePhoto("a");
    h.broadcasts.length = 0;

    state().setActivePhoto(null);

    expect(state().activePhotoId).toBeNull();
    expect(h.broadcasts).toEqual([]);
  });
});

describe("startup and reconnect", () => {
  it("loadCatalog holds the loading flag across the reopen", async () => {
    let loadingDuringOpen = false;
    h.openLast.mockImplementation(async () => {
      loadingDuringOpen = state().loading;
    });

    await state().loadCatalog();

    expect(loadingDuringOpen).toBe(true);
    expect(state().loading).toBe(false);
  });

  it("loadCatalog clears the loading flag when the reopen fails", async () => {
    h.openLast.mockRejectedValue(new Error("folder gone"));

    await expect(state().loadCatalog()).rejects.toThrow("folder gone");
    expect(state().loading).toBe(false);
  });

  it("reconnectFiles clears the reconnect prompt and forces a bitmap reload", async () => {
    useCatalogStore.setState({ needsReconnect: true });
    h.reconnectLast.mockResolvedValue(true);

    await state().reconnectFiles();

    expect(state().needsReconnect).toBe(false);
    expect(state().fileAccessNonce).toBe(1);
    expect(state().reconnecting).toBe(false);
  });

  it("reconnectFiles keeps the prompt up when permission is refused", async () => {
    h.reconnectLast.mockResolvedValue(false);

    await state().reconnectFiles();

    expect(state().needsReconnect).toBe(true);
    expect(state().reconnecting).toBe(false);
  });

  it("reconnectFiles ignores a second click while a re-grant is in flight", async () => {
    useCatalogStore.setState({ reconnecting: true });

    await state().reconnectFiles();

    expect(state().fileAccessNonce).toBe(0);
    expect(state().reconnecting).toBe(true);
  });
});
