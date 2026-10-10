// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Develop status-bar button that moves an older photo to the current
// processing. It is only there for a photo on the older processing, and one
// click is one undoable step.

import { beforeEach, describe, expect, it, vi } from "vitest";

// The store's commits broadcast to sibling windows; not under test here.
vi.mock("@/state/broadcast", () => ({
  broadcast: () => {},
  onBroadcast: () => () => {},
  WINDOW_ID: "test-window",
}));

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  CURRENT_PROCESS_VERSION,
  LEGACY_PROCESS_VERSION,
  normalizeParams,
} from "@/catalog/types";
import { useDevelopStore } from "@/state/develop-store";
import { ProcessingUpdateControl } from "./ProcessingUpdateControl";

const TOOLTIP =
  "This photo uses the older processing, which clips bright, very saturated colours early. " +
  "Update it to keep them. Undo puts it back.";

// zustand keeps the actions in state, so the pristine object doubles as the
// reset baseline (nothing mutates it in place).
const INITIAL = useDevelopStore.getState();

function seedPhoto(processVersion: number, photoId: string | null = "photo-1") {
  const params = normalizeParams({ processVersion });
  useDevelopStore.setState({
    photoId,
    params,
    paramBag: {},
    history: [{ timestamp: 0, label: "Original", params, paramBag: {} }],
    historyIndex: 0,
  });
}

// Every version from the first to one past the current one, so a later version bump
// is covered without touching this file.
const VERSIONS = Array.from(
  { length: CURRENT_PROCESS_VERSION - LEGACY_PROCESS_VERSION + 2 },
  (_, i) => LEGACY_PROCESS_VERSION + i,
);

const update = () => screen.getByRole("button", { name: "Update processing" });
const maybeUpdate = () => screen.queryByRole("button", { name: "Update processing" });
const version = () => useDevelopStore.getState().params.processVersion;
const topLabel = () => {
  const { history, historyIndex } = useDevelopStore.getState();
  return history[historyIndex].label;
};

beforeEach(() => useDevelopStore.setState(INITIAL, true));

describe("ProcessingUpdateControl", () => {
  it("renders nothing with no photo open", () => {
    seedPhoto(LEGACY_PROCESS_VERSION, null);
    const { container } = render(<ProcessingUpdateControl />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing on a photo that is already current", () => {
    seedPhoto(CURRENT_PROCESS_VERSION);
    const { container } = render(<ProcessingUpdateControl />);
    expect(container.firstChild).toBeNull();
  });

  it.each(VERSIONS)("is shown for version %i exactly when the action updates it", async (v) => {
    seedPhoto(v);
    render(<ProcessingUpdateControl />);
    const shown = maybeUpdate() !== null;

    await act(() => useDevelopStore.getState().updateProcessing());

    const updated = useDevelopStore.getState().history.length > 1;
    expect(shown).toBe(updated);
  });

  it("offers the update on a photo that uses the older processing, with a tooltip", () => {
    seedPhoto(LEGACY_PROCESS_VERSION);
    render(<ProcessingUpdateControl />);
    expect(update().getAttribute("title")).toBe(TOOLTIP);
  });

  it("asks the store to update the photo when clicked", async () => {
    const updateProcessing = vi.fn(async () => {});
    seedPhoto(LEGACY_PROCESS_VERSION);
    useDevelopStore.setState({ updateProcessing });
    const user = userEvent.setup();
    render(<ProcessingUpdateControl />);

    await user.click(update());

    expect(updateProcessing).toHaveBeenCalledTimes(1);
  });

  it("goes away once the photo is updated, and comes back if that is undone", async () => {
    seedPhoto(LEGACY_PROCESS_VERSION);
    const user = userEvent.setup();
    render(<ProcessingUpdateControl />);

    await user.click(update());
    expect(version()).toBe(CURRENT_PROCESS_VERSION);
    expect(topLabel()).toBe("Update processing");
    expect(maybeUpdate()).toBeNull();

    act(() => useDevelopStore.getState().undo());
    expect(version()).toBe(LEGACY_PROCESS_VERSION);
    expect(maybeUpdate()).not.toBeNull();
  });
});
