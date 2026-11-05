// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The API members the Library and Develop modules reach core through once they
// leave it. Each is core's own implementation, so the modules behave as they
// did built in. In the dom project because host.tsx's import graph reaches
// stores that expect a window.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { makeScopedAPI } from "./host";
import { Slot } from "./Slot";
import { VirtualGrid } from "@/ui/components/VirtualGrid";
import { ZoomControls } from "@/ui/ZoomControls";
import { SurroundControl } from "@/ui/SurroundControl";
import { DisplayTransformControl } from "@/ui/DisplayTransformControl";
import { ProcessingUpdateControl } from "@/modules/develop/ProcessingUpdateControl";
import { DevelopStage } from "@/modules/develop/DevelopStage";
import { AssessmentToggle, ProofToggle } from "@/modules/develop/view-toggles";
import { alertDialog } from "@/ui/components/ConfirmDialog";
import { photoDisplayName } from "@/catalog/copy-name";
import { exportPhotoData } from "@/project/folder-ops";
import { GRID_SIZE_MAX, GRID_SIZE_MIN, GRID_SIZE_STEP } from "@/state/ui-store";
import { useCatalogStore } from "@/state/catalog-store";
import type { CatalogPhoto } from "@/catalog/types";

class SilentChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("BroadcastChannel", SilentChannel);
});

afterEach(() => {
  useCatalogStore.setState({ photos: [], activePhotoId: null });
  vi.unstubAllGlobals();
});

const api = () => makeScopedAPI("ext.modules");

const photo = (id: string): CatalogPhoto =>
  ({ id, filename: `${id}.jpg`, keywords: [], exif: {} }) as unknown as CatalogPhoto;

describe("components for the modules", () => {
  it("hands over the Library grid's building blocks", () => {
    const { components } = api();
    expect(components.Slot).toBe(Slot);
    expect(components.VirtualGrid).toBe(VirtualGrid);
  });

  it("hands over the develop canvas and the status-bar controls", () => {
    const { components } = api();
    expect(components.DevelopCanvas).toBe(DevelopStage);
    expect(components.ZoomControls).toBe(ZoomControls);
    expect(components.SurroundControl).toBe(SurroundControl);
    expect(components.DisplayTransformControl).toBe(DisplayTransformControl);
    expect(components.ProcessingUpdateControl).toBe(ProcessingUpdateControl);
    expect(components.ProofToggle).toBe(ProofToggle);
    expect(components.AssessmentToggle).toBe(AssessmentToggle);
  });
});

describe("api.ui.alertDialog", () => {
  it("is core's", () => {
    expect(api().ui.alertDialog).toBe(alertDialog);
  });
});

describe("api.catalog additions for the modules", () => {
  it("hands over the display name and the sidecar export", () => {
    const { catalog } = api();
    expect(catalog.photoDisplayName).toBe(photoDisplayName);
    expect(catalog.exportPhotoData).toBe(exportPhotoData);
  });

  it("gives the thumbnail size range the grid size control steps through", () => {
    expect(api().catalog.gridSize).toEqual({
      min: GRID_SIZE_MIN,
      max: GRID_SIZE_MAX,
      step: GRID_SIZE_STEP,
    });
  });

  it("follows the active photo", () => {
    useCatalogStore.setState({ photos: [photo("a"), photo("b")], activePhotoId: "a" });
    const { result } = renderHook(() => api().catalog.useActivePhoto());
    expect(result.current?.id).toBe("a");

    act(() => useCatalogStore.setState({ activePhotoId: "b" }));
    expect(result.current?.id).toBe("b");

    act(() => useCatalogStore.setState({ activePhotoId: null }));
    expect(result.current).toBeUndefined();
  });
});
