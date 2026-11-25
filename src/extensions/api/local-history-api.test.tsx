// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Local history (#281) as extensions reach it. Each extension's
// api.stores.useDevelopStore commits in its own name, so the steps it makes
// belong to it without the extension doing anything; api.develop reads an
// extension's steps back and shares the History panel's pick of which one to
// show. In the dom project because host.tsx's import graph reaches stores that
// expect a window.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

vi.mock("@/state/broadcast", () => ({
  broadcast: vi.fn(),
  onBroadcast: () => () => {},
  WINDOW_ID: "test-window",
}));
vi.mock("@/state/edited-thumbnail", () => ({ regenerateEditedThumbnail: vi.fn() }));

import { makeScopedAPI } from "../host";
import { setExtensionName } from "../param-registry";
import { useDevelopStore } from "@/state/develop-store";
import { useCatalogStore } from "@/state/catalog-store";
import { useHistoryPin } from "@/state/history-choice";
import { setCatalogStorage } from "@/catalog/storage";
import { normalizeParams } from "@/catalog/types";
import { installMemoryStorage, photo } from "@/catalog/stored-edit.fixtures";

const PHOTO_ID = "photo-1";
const INITIAL = useDevelopStore.getState();
const top = () => {
  const { history, historyIndex } = useDevelopStore.getState();
  return history[historyIndex];
};

beforeEach(async () => {
  useDevelopStore.setState(INITIAL, true);
  useHistoryPin.setState({ pin: null });
  useCatalogStore.setState({ photos: [photo(PHOTO_ID)] });
  installMemoryStorage();
  await useDevelopStore.getState().loadEdit(PHOTO_ID, 5000);
  setExtensionName("basic", "Basic");
  setExtensionName("hsl", "HSL");
});

afterEach(() => {
  setCatalogStorage(null);
});

describe("api.stores.useDevelopStore", () => {
  it("commits a step in the extension's name through getState()", async () => {
    const store = makeScopedAPI("basic").stores.useDevelopStore;
    store.getState().setParam("exposure", 1);
    await store.getState().commitEdit("Exposure");
    expect(top()).toMatchObject({ label: "Exposure", source: "basic" });
  });

  it("commits in the extension's name through a selector, with one function across renders", async () => {
    const store = makeScopedAPI("hsl").stores.useDevelopStore;
    const { result, rerender } = renderHook(() => store((s) => s.commitEdit));
    const first = result.current;
    act(() => useDevelopStore.getState().setParam("saturation", 10));
    rerender();
    expect(result.current).toBe(first);
    await act(() => result.current("Saturation"));
    expect(top()).toMatchObject({ label: "Saturation", source: "hsl" });
  });

  it("names the extension on resetParams, restoreEdit and applyPreset", async () => {
    const dev = makeScopedAPI("basic").stores.useDevelopStore.getState();
    await dev.restoreEdit({ params: normalizeParams({ exposure: 2 }) }, "Snapshot");
    expect(top().source).toBe("basic");
    await dev.resetParams(["exposure"], "Reset Exposure");
    expect(top().source).toBe("basic");
    await dev.applyPreset(normalizeParams({ contrast: 3 }));
    expect(top().source).toBe("basic");
  });

  it("leaves a full reset to core", async () => {
    const dev = makeScopedAPI("basic").stores.useDevelopStore.getState();
    dev.setParam("exposure", 1);
    await dev.commitEdit("Exposure");
    await dev.reset();
    expect(top().label).toBe("Reset");
    expect(top()).not.toHaveProperty("source");
  });

  it("reads and writes the app's own store", () => {
    const store = makeScopedAPI("basic").stores.useDevelopStore;
    store.setState({ showClipping: 2 });
    expect(useDevelopStore.getState().showClipping).toBe(2);
    expect(store.getState().params).toBe(useDevelopStore.getState().params);
  });

  it("hands subscribers the state with the extension's commits", async () => {
    const store = makeScopedAPI("basic").stores.useDevelopStore;
    const seen: Array<() => Promise<void>> = [];
    const stop = store.subscribe((s) => seen.push(() => s.commitEdit("Exposure")));
    useDevelopStore.getState().setParam("exposure", 1);
    stop();
    await seen[0]();
    expect(top().source).toBe("basic");
  });
});

describe("api.develop.useParamScope", () => {
  it("commits in the extension's name", async () => {
    const api = makeScopedAPI("basic");
    const { result } = renderHook(() => api.develop.useParamScope());
    useDevelopStore.getState().setParam("exposure", 1);
    await act(async () => result.current.commit("Exposure"));
    expect(top().source).toBe("basic");
  });
});

describe("api.develop's local history", () => {
  async function edit(id: string, label: string, key: "exposure" | "saturation", value: number) {
    const dev = makeScopedAPI(id).stores.useDevelopStore.getState();
    dev.setParam(key, value);
    await dev.commitEdit(label);
  }

  it("lists the extensions with steps, latest edited first, by name", async () => {
    await edit("basic", "Exposure", "exposure", 1);
    await edit("hsl", "Saturation", "saturation", 10);
    const { result } = renderHook(() => makeScopedAPI("history").develop.useHistorySources());
    expect(result.current).toEqual([
      { id: "hsl", name: "HSL" },
      { id: "basic", name: "Basic" },
    ]);
  });

  it("reads one extension's steps and where it stands", async () => {
    await edit("basic", "Exposure", "exposure", 1);
    await edit("hsl", "Saturation", "saturation", 10);
    await edit("basic", "Exposure", "exposure", 2);
    const api = makeScopedAPI("history");
    const { result } = renderHook(() => api.develop.useLocalHistory("basic"));
    expect(result.current).toMatchObject({ source: "basic", name: "Basic", cursor: 1 });
    expect(result.current?.steps.map((s) => s.index)).toEqual([1, 3]);
    await act(() => useDevelopStore.getState().localUndo("basic"));
    expect(result.current?.cursor).toBe(0);
  });

  it("reads nothing for no extension", () => {
    const { result } = renderHook(() => makeScopedAPI("history").develop.useLocalHistory(null));
    expect(result.current).toBeNull();
  });

  it("shares the chosen extension: the latest edited, or the one picked until another edits", async () => {
    await edit("basic", "Exposure", "exposure", 1);
    await edit("hsl", "Saturation", "saturation", 10);
    const history = makeScopedAPI("history");
    const edit2 = makeScopedAPI("safelight.edit");
    const chosen = renderHook(() => edit2.develop.useChosenHistorySource());
    expect(chosen.result.current).toBe("hsl");

    act(() => history.develop.chooseHistorySource("basic"));
    expect(chosen.result.current).toBe("basic");

    await act(() => edit("hsl", "Saturation", "saturation", 20));
    expect(chosen.result.current).toBe("hsl");
  });
});
