// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The canvas area core hands the Develop module: the surround behind the image
// (which the renderer reads its crop margin from) and, with no photo open, the
// module's own empty state inside it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useDevelopStore } from "@/state/develop-store";
import { regenerateEditedThumbnail } from "@/state/edited-thumbnail";
import { useCatalogStore } from "@/state/catalog-store";
import { catalogStorage, setCatalogStorage } from "@/catalog/storage";
import { installMemoryStorage, photo } from "@/catalog/stored-edit.fixtures";
import { DevelopStage } from "./DevelopStage";

vi.mock("./DevelopCanvas", () => ({ DevelopCanvas: () => null }));
vi.mock("@/state/edited-thumbnail", () => ({ regenerateEditedThumbnail: vi.fn() }));

const INITIAL = useDevelopStore.getState();

afterEach(() => {
  useDevelopStore.setState(INITIAL, true);
  useCatalogStore.setState({ photos: [], activePhotoId: null });
  setCatalogStorage(null);
});

const surround = () => document.querySelector<HTMLElement>("[data-canvas-surround]");

describe("DevelopStage", () => {
  it("shows the module's empty state in the surround when no photo is open", () => {
    render(<DevelopStage zoom={null} onZoomChange={() => {}} empty={<p>No photo selected</p>} />);
    expect(surround()?.contains(screen.getByText("No photo selected"))).toBe(true);
  });

  it("follows the theme's surround at full opacity, and the ISO middle grey under colour assessment", () => {
    render(<DevelopStage zoom={null} onZoomChange={() => {}} />);
    // A translucent theme surface (a window-material theme) must not let the
    // desktop through behind the image.
    expect(surround()?.style.background).toBe(
      "rgb(from var(--color-canvas-surround, var(--color-surface-0)) r g b / 1)",
    );

    act(() => useDevelopStore.setState({ colorAssessment: true }));
    expect(surround()?.style.background).toBe("rgb(102, 102, 102)");
  });

  it("says so, and offers another try, when the open photo's edits can't be read", async () => {
    installMemoryStorage();
    const base = catalogStorage();
    let failing = true;
    setCatalogStorage({
      ...base,
      getEditState: async (id) => {
        if (failing) throw new Error("EBUSY: resource busy or locked, open 'D:/Shoot/.safelight/edits/A.json'");
        return base.getEditState(id);
      },
    });
    useCatalogStore.setState({ photos: [photo("A")], activePhotoId: "A" });

    render(<DevelopStage zoom={null} onZoomChange={() => {}} />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Can't open this photo's saved edits (the file is locked or can't be read). Changes to " +
        "it won't be saved until it opens.",
    );
    expect(screen.getByRole("alert").textContent).not.toMatch(/EBUSY|Shoot/);

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(useDevelopStore.getState().history).toHaveLength(1);
  });

  describe("returning to the open photo", () => {
    function countingStorage() {
      installMemoryStorage();
      const base = catalogStorage();
      const reads: string[] = [];
      setCatalogStorage({
        ...base,
        getEditState: async (id) => {
          reads.push(id);
          return base.getEditState(id);
        },
      });
      return reads;
    }
    const stage = <DevelopStage zoom={null} onZoomChange={() => {}} />;

    it("doesn't read the edit again, and keeps the params it holds", async () => {
      const reads = countingStorage();
      useCatalogStore.setState({ photos: [photo("A")], activePhotoId: "A" });
      const first = render(stage);
      await vi.waitFor(() => expect(useDevelopStore.getState().photoId).toBe("A"));
      const held = useDevelopStore.getState().params;
      first.unmount();

      render(stage);
      await act(async () => {});

      expect(reads).toEqual(["A"]);
      expect(useDevelopStore.getState().params).toBe(held);
    });

    it("keeps a change not yet committed", async () => {
      countingStorage();
      useCatalogStore.setState({ photos: [photo("A")], activePhotoId: "A" });
      const first = render(stage);
      await vi.waitFor(() => expect(useDevelopStore.getState().photoId).toBe("A"));
      act(() => useDevelopStore.getState().setParam("exposure", 1.5));
      first.unmount();

      render(stage);
      await act(async () => {});

      expect(useDevelopStore.getState().params.exposure).toBe(1.5);
    });

    it("reads again when the photo's as-shot temperature has changed", async () => {
      const reads = countingStorage();
      useCatalogStore.setState({ photos: [photo("A")], activePhotoId: "A" });
      const first = render(stage);
      await vi.waitFor(() => expect(useDevelopStore.getState().photoId).toBe("A"));
      first.unmount();

      const learned = photo("A");
      learned.exif = { colorTemperature: 5200 };
      useCatalogStore.setState({ photos: [learned] });
      render(stage);

      await vi.waitFor(() => expect(useDevelopStore.getState().asShotTemperature).toBe(5200));
      expect(reads).toEqual(["A", "A"]);
    });

    it("reads again after a failed read", async () => {
      const reads = countingStorage();
      useCatalogStore.setState({ photos: [photo("A")], activePhotoId: "A" });
      const first = render(stage);
      await vi.waitFor(() => expect(useDevelopStore.getState().photoId).toBe("A"));
      first.unmount();
      act(() => useDevelopStore.setState({ editError: "locked" }));

      render(stage);

      await vi.waitFor(() => expect(reads).toEqual(["A", "A"]));
    });

    it("draws the thumbnail still waiting for quiet as Develop is left", async () => {
      countingStorage();
      vi.mocked(regenerateEditedThumbnail).mockClear();
      useCatalogStore.setState({ photos: [photo("A")], activePhotoId: "A" });
      const open = render(stage);
      await vi.waitFor(() => expect(useDevelopStore.getState().photoId).toBe("A"));
      act(() => useDevelopStore.getState().setParam("temperature", 5000));
      await act(() => useDevelopStore.getState().commitEdit("Edit"));
      expect(regenerateEditedThumbnail).not.toHaveBeenCalled();

      open.unmount();

      expect(regenerateEditedThumbnail).toHaveBeenCalledTimes(1);
    });

    it("still reads a different photo", async () => {
      const reads = countingStorage();
      useCatalogStore.setState({ photos: [photo("A"), photo("B")], activePhotoId: "A" });
      render(stage);
      await vi.waitFor(() => expect(useDevelopStore.getState().photoId).toBe("A"));

      act(() => useCatalogStore.setState({ activePhotoId: "B" }));

      await vi.waitFor(() => expect(useDevelopStore.getState().photoId).toBe("B"));
      expect(reads).toEqual(["A", "B"]);
    });
  });
});
