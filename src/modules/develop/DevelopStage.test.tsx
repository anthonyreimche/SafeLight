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
import { useCatalogStore } from "@/state/catalog-store";
import { catalogStorage, setCatalogStorage } from "@/catalog/storage";
import { installMemoryStorage, photo } from "@/catalog/stored-edit.fixtures";
import { DevelopStage } from "./DevelopStage";

vi.mock("./DevelopCanvas", () => ({ DevelopCanvas: () => null }));

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

  it("follows the theme's surround, and the ISO middle grey under color assessment", () => {
    render(<DevelopStage zoom={null} onZoomChange={() => {}} />);
    expect(surround()?.style.background).toBe("var(--color-canvas-surround, var(--color-surface-0))");

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
});
