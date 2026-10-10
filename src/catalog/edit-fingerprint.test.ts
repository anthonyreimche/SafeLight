// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Develop draws a photo's stored preview first only while it shows the photo's
// current edit. The preview carries the fingerprint of the edit it was rendered
// from, and Develop compares it with the fingerprint of the edit it loaded. The
// two sides hold the same edit in different shapes: the live params a commit
// renders from, and those params saved, read back and normalised. If they hashed
// apart, no stored preview would ever be drawn, and the first pixels would wait
// for the decode without any test failing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/state/broadcast", () => ({
  broadcast: vi.fn(),
  onBroadcast: () => () => {},
  WINDOW_ID: "test-window",
}));
vi.mock("@/state/edited-thumbnail", () => ({ regenerateEditedThumbnail: vi.fn() }));

import { editFingerprint } from "./edit-fingerprint";
import { installMemoryStorage, photo } from "./stored-edit.fixtures";
import { setCatalogStorage } from "./storage";
import {
  defaultMaskAdjustments,
  freshParams,
  mergeStoredPhoto,
  normalizeParams,
  storedPhoto,
  type DevelopParams,
  type EditState,
  type Mask,
  type RetouchSpot,
} from "./types";
import { regenerateEditedThumbnail } from "@/state/edited-thumbnail";
import { useCatalogStore } from "@/state/catalog-store";
import { useDevelopStore } from "@/state/develop-store";

const PHOTO = "photo-1";
const AS_SHOT = 5200;

// A brush mask as the mask tools paint it.
const brushMask: Mask = {
  id: "m1",
  name: "Sky",
  visible: true,
  invert: false,
  opacity: 80,
  adj: { ...defaultMaskAdjustments(), exposure: -30 },
  panels: ["core.basic"],
  components: [
    {
      id: "m1-c0",
      kind: "brush",
      mode: "add",
      invert: false,
      brush: {
        feather: 0.4,
        dabs: [{ x: 0.2, y: 0.3, radius: 0.05, erase: false, feather: 0.5, opacity: 1, flow: 0.6 }],
      },
    },
  ],
};

// Retouch spots as the retouch tool leaves them: a painted stroke's dabs carry no
// opacity or flow, and a stroke shrunk back to a circle keeps `dabs: undefined`.
const strokeSpot: RetouchSpot = {
  id: "s1",
  shape: "brush",
  mode: "heal",
  visible: true,
  dstX: 0.4,
  dstY: 0.4,
  srcX: 0.5,
  srcY: 0.45,
  radius: 0.03,
  feather: 50,
  opacity: 100,
  angle: 0,
  scale: 1,
  recolorR: 0,
  recolorG: 0,
  recolorB: 0,
  dabs: [
    { x: 0.4, y: 0.4, radius: 0.03, erase: false, feather: 0.5 },
    { x: 0.42, y: 0.41, radius: 0.03, erase: false, feather: 0.5 },
  ],
};
const circleSpot: RetouchSpot = {
  ...strokeSpot,
  id: "s2",
  shape: "circle",
  dabs: undefined,
};

/** An edit as Develop commits it: the live params after a session of edits. */
function committedEdit(): DevelopParams {
  return {
    ...freshParams(AS_SHOT),
    exposure: 0.65,
    contrast: 12,
    toneCurve: {
      ...freshParams(AS_SHOT).toneCurve,
      rgb: [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.56 },
        { x: 1, y: 1 },
      ],
    },
    colorGrading: {
      ...freshParams(AS_SHOT).colorGrading,
      shadows: { hue: 210, sat: 20, luma: 0 },
    },
    masks: [brushMask],
    retouch: [strokeSpot, circleSpot],
  };
}

const BAG = { "ext.film.stock": "portra", "ext.film.grain": 0.3, "ext.denoise.amount": 40 };

/** `value` rebuilt with every object's keys in the reverse order. */
function reversedKeys<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).reverse())
      : v,
  );
}

describe("editFingerprint", () => {
  it("is the same for an edit Develop commits and that edit normalised", () => {
    const params = committedEdit();
    expect(normalizeParams(params)).not.toEqual(params);
    expect(editFingerprint(normalizeParams(params), BAG)).toBe(editFingerprint(params, BAG));
  });

  it("doesn't depend on the order of keys, in the params or in the bag", () => {
    const params = committedEdit();
    expect(editFingerprint(reversedKeys(params), reversedKeys(BAG))).toBe(
      editFingerprint(params, BAG),
    );
  });

  it("counts a key set to undefined as absent, as saving does", () => {
    expect(editFingerprint(committedEdit(), { ...BAG, "ext.gone.amount": undefined })).toBe(
      editFingerprint(committedEdit(), BAG),
    );
  });

  it.each([
    ["an adjustment", { ...committedEdit(), exposure: 0.7 }, BAG],
    ["a mask", { ...committedEdit(), masks: [{ ...brushMask, opacity: 70 }] }, BAG],
    ["an extension's setting", committedEdit(), { ...BAG, "ext.film.grain": 0.31 }],
    ["an extension's setting added", committedEdit(), { ...BAG, "ext.lut.strength": 1 }],
  ])("tells two edits apart that differ in %s", (_label, params, bag) => {
    expect(editFingerprint(params, bag)).not.toBe(editFingerprint(committedEdit(), BAG));
  });
});

describe("an edit committed in Develop and opened again", () => {
  const INITIAL = useDevelopStore.getState();
  const s = () => useDevelopStore.getState();

  beforeEach(() => {
    useDevelopStore.setState(INITIAL, true);
    useCatalogStore.setState({ photos: [photo(PHOTO)] });
    vi.mocked(regenerateEditedThumbnail).mockClear();
  });

  afterEach(() => {
    setCatalogStorage(null);
  });

  /** The fingerprint of the look the last grid-preview render was asked for. */
  function lastRendered(): string {
    const call = vi.mocked(regenerateEditedThumbnail).mock.calls.at(-1);
    if (!call) throw new Error("no preview was rendered");
    const [, params, , bag] = call;
    return editFingerprint(params, bag ?? {});
  }

  /** Develop opened again on the photo, from `stored` as the catalog holds it. */
  async function reopen(stored: EditState) {
    installMemoryStorage(stored);
    useDevelopStore.setState(INITIAL, true);
    await s().loadEdit(PHOTO, AS_SHOT);
  }

  async function editInDevelop() {
    const memory = installMemoryStorage();
    await s().loadEdit(PHOTO, AS_SHOT);
    useDevelopStore.setState({
      params: committedEdit(),
      paramBag: { ...s().paramBag, ...BAG, "ext.gone.amount": undefined },
    });
    await s().commitEdit("Edit");
    return memory;
  }

  const savedTo = {
    "this session's memory": (state: EditState): EditState => state,
    "catalog.json": (state: EditState): EditState => JSON.parse(JSON.stringify(state)),
  };

  it.each(Object.entries(savedTo))(
    "hashes like the edit its preview was rendered from, read back from %s",
    async (_where, save) => {
      const memory = await editInDevelop();
      const rendered = lastRendered();
      const stored = memory.written.at(-1);
      if (!stored) throw new Error("the edit was not stored");

      await reopen(save(stored));

      expect(editFingerprint(s().params, s().paramBag)).toBe(rendered);
    },
  );

  it.each(Object.entries(savedTo))(
    "hashes like the step an undo rendered, read back from %s",
    async (_where, save) => {
      const memory = await editInDevelop();
      s().setParam("exposure", 1.2);
      await s().commitEdit("Exposure");
      s().undo();
      const rendered = lastRendered();
      const stored = memory.written.at(-1);
      if (!stored) throw new Error("the edit was not stored");

      await reopen(save(stored));

      expect(s().params.exposure).toBe(0.65);
      expect(editFingerprint(s().params, s().paramBag)).toBe(rendered);
    },
  );
});

// The fingerprint is a field of the photo record: it is saved with the record in
// catalog.json and reaches the other windows with it.
describe("a photo's preview edit", () => {
  const edited = { ...photo(PHOTO), previewEdit: "0123456789abcdef" };

  it("is saved with the record", () => {
    expect(JSON.parse(JSON.stringify(storedPhoto(edited)))).toMatchObject({
      previewEdit: "0123456789abcdef",
    });
  });

  it("is taken from another window's record, and cleared when that record has none", () => {
    const here = photo(PHOTO);
    expect(mergeStoredPhoto(here, storedPhoto(edited)).previewEdit).toBe("0123456789abcdef");
    expect(mergeStoredPhoto(edited, storedPhoto(here)).previewEdit).toBeUndefined();
  });
});
