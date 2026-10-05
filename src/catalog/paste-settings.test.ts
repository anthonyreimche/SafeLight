// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Paste settings onto Library photos: the pasted subset merges over each
// photo's look, and a paste never moves a photo between process versions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pasteSettings } from "./paste-settings";
import { installMemoryStorage, photo } from "./stored-edit.fixtures";
import { setCatalogStorage } from "./storage";
import {
  CURRENT_PROCESS_VERSION,
  LEGACY_PROCESS_VERSION,
  freshParams,
  type DevelopParams,
  type EditState,
} from "./types";
import { useCatalogStore } from "@/state/catalog-store";
import { useDevelopStore } from "@/state/develop-store";

vi.mock("@/state/broadcast", () => ({
  broadcast: vi.fn(),
  onBroadcast: () => () => {},
  WINDOW_ID: "test-window",
}));

// zustand keeps the actions in state, so the pristine object doubles as the
// reset baseline (nothing mutates it in place).
const INITIAL_DEVELOP = useDevelopStore.getState();

const PHOTO = "photo-1";

let written: EditState[];

function install(seed?: EditState): void {
  written = installMemoryStorage(...(seed ? [seed] : [])).written;
}

const clip = (params: Partial<DevelopParams>) => ({
  params,
  paramBag: {},
  sourceName: "source.jpg",
  fieldCount: Object.keys(params).length,
});

beforeEach(() => {
  useCatalogStore.setState({ photos: [photo(PHOTO)] });
});

afterEach(() => {
  setCatalogStorage(null);
  useDevelopStore.setState(INITIAL_DEVELOP, true);
});

describe("pasteSettings — process versions", () => {
  it("starts a never-edited photo at the current version", async () => {
    install();
    await pasteSettings([PHOTO], clip({ exposure: 1 }));
    const { stack } = written.at(-1)!;
    expect(stack[0].label).toBe("Original");
    expect(stack[0].params.processVersion).toBe(CURRENT_PROCESS_VERSION);
    const top = stack.at(-1)!;
    expect(top.params.exposure).toBe(1);
    expect(top.params.processVersion).toBe(CURRENT_PROCESS_VERSION);
  });

  it("keeps an old edit at version 1 even when the clipboard carries a version", async () => {
    install({
      photoId: PHOTO,
      currentIndex: 0,
      // Written by a build from before process versions: no version field.
      stack: [{ timestamp: 0, label: "Edit", params: { exposure: 0.5 } as DevelopParams }],
    });
    await pasteSettings([PHOTO], clip({ contrast: 10, processVersion: 2 }));
    const top = written.at(-1)!.stack.at(-1)!;
    expect(top.params.contrast).toBe(10);
    expect(top.params.exposure).toBe(0.5);
    expect(top.params.processVersion).toBe(LEGACY_PROCESS_VERSION);
  });
});

describe("pasteSettings — a stored cursor outside its stack", () => {
  const stackWithCursor = (currentIndex: number): EditState => ({
    photoId: PHOTO,
    currentIndex,
    stack: [
      { timestamp: 0, label: "First", params: { exposure: 0.25 } as DevelopParams },
      { timestamp: 0, label: "Second", params: { exposure: 0.5 } as DevelopParams },
    ],
  });

  it.each([
    { cursor: 7, base: "last", exposure: 0.5, labels: ["First", "Second", "Paste Settings"] },
    { cursor: NaN, base: "newest", exposure: 0.5, labels: ["First", "Second", "Paste Settings"] },
    { cursor: -3, base: "first", exposure: 0.25, labels: ["First", "Paste Settings"] },
  ])("merges over the $base snapshot when the cursor is $cursor", async ({ cursor, exposure, labels }) => {
    install(stackWithCursor(cursor));
    await pasteSettings([PHOTO], clip({ contrast: 10 }));
    const { stack } = written.at(-1)!;
    expect(stack.map((snap) => snap.label)).toEqual(labels);
    expect(stack.at(-1)!.params.exposure).toBe(exposure);
    expect(stack.at(-1)!.params.contrast).toBe(10);
  });
});

describe("pasteSettings — the photo open in Develop", () => {
  const seed = (): EditState => ({
    photoId: PHOTO,
    currentIndex: 0,
    stack: [{ timestamp: 0, label: "Original", params: freshParams() }],
  });

  it("is reloaded, so Develop's history holds the pasted step", async () => {
    install(seed());
    await useDevelopStore.getState().loadEdit(PHOTO);

    await pasteSettings([PHOTO], clip({ contrast: 10 }));

    const develop = useDevelopStore.getState();
    expect(develop.history.map((snap) => snap.label)).toEqual(["Original", "Paste Settings"]);
    expect(develop.historyIndex).toBe(1);
    expect(develop.params.contrast).toBe(10);
  });

  it("is left alone when another photo is open", async () => {
    install(seed());
    useCatalogStore.setState({ photos: [photo(PHOTO), photo("photo-2")] });
    await useDevelopStore.getState().loadEdit("photo-2");
    const { history } = useDevelopStore.getState();

    await pasteSettings([PHOTO], clip({ contrast: 10 }));

    expect(useDevelopStore.getState().history).toBe(history);
  });
});
