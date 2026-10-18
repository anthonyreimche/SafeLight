// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A RAW imported from its camera preview shows the preview's size until its
// metadata is read from the whole file. The Metadata panel has that read done
// for the photo it shows, rather than leave it to the background pass.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Records announce themselves to sibling windows; not under test here.
vi.mock("@/state/broadcast", () => ({
  broadcast: () => {},
  onBroadcast: () => () => {},
  WINDOW_ID: "test-window",
}));

import { render, waitFor } from "@testing-library/react";
import type { CatalogPhoto } from "@/catalog/types";
import { installMemoryStorage, photo } from "@/catalog/stored-edit.fixtures";
import { setCatalogStorage } from "@/catalog/storage";
import { useCatalogStore } from "@/state/catalog-store";
import { MetadataPanel } from "./MetadataPanel";

/** `id` as a RAW whose file reads go through the returned spy. */
function raw(id: string, extra: Partial<CatalogPhoto> = {}) {
  const getFile = vi.fn(async () => new File([new Uint8Array(64)], `${id}.NEF`));
  const record: CatalogPhoto = {
    ...photo(id),
    fileHandle: { kind: "file", name: `${id}.NEF`, getFile } as unknown as FileSystemFileHandle,
    ...extra,
  };
  return { record, getFile };
}

const held = (id: string) => useCatalogStore.getState().photos.find((p) => p.id === id);

beforeEach(() => {
  installMemoryStorage();
});

afterEach(() => setCatalogStorage(null));

describe("the Metadata panel", () => {
  it("has the metadata read for a selected photo whose import left it pending", async () => {
    const a = raw("a", { metadataPending: true, width: 1620, height: 1080 });
    useCatalogStore.setState({ photos: [a.record], activePhotoId: "a" });

    render(<MetadataPanel />);

    await waitFor(() => expect(held("a")?.metadataPending).toBeUndefined());
    expect(a.getFile).toHaveBeenCalledTimes(1);
  });

  it("reads no file for a selected photo whose metadata is known", async () => {
    const a = raw("a");
    useCatalogStore.setState({ photos: [a.record], activePhotoId: "a" });

    render(<MetadataPanel />);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(a.getFile).not.toHaveBeenCalled();
  });
});
