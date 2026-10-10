// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Preferences ▸ Previews starts "Cache all now" and "Rebuild thumbnails" on the
// open project, and both stop once the user leaves it: after a project switch
// they read no more of its files. The project's passes signal is faked; the
// passes run for real, on decoders that decline every file at once (this page
// has no Worker).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** The open project's passes, as project-store hands them out. */
  project: new AbortController(),
  /** How often the dialog asked for that signal. */
  asked: 0,
}));

vi.mock("@/project/project-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/project/project-store")>()),
  projectPassSignal: () => {
    h.asked++;
    return h.project.signal;
  },
}));

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { rawPhoto } from "@/modules/library/raw-photo.test-support";
import { useCatalogStore } from "@/state/catalog-store";
import { updateSettings } from "@/state/settings-store";
import { openPreferences, PreferencesDialog } from "./PreferencesDialog";

class SilentChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

/** Each original read, by name. */
let reads: string[] = [];

/** RAWs of the open project. Unless told otherwise, reading the first one
 *  switches projects; that read lasts until `firstRead` settles. */
function rawsOfTheOpenProject({
  switchOnRead = true,
  firstRead,
}: { switchOnRead?: boolean; firstRead?: Promise<void> } = {}): void {
  const photos = ["A.NEF", "B.NEF", "C.NEF", "D.NEF"].map((name) =>
    rawPhoto(name, {
      onRead: () => {
        reads.push(name);
        if (switchOnRead) h.project.abort();
        return name === "A.NEF" ? firstRead : undefined;
      },
    }),
  );
  useCatalogStore.setState({ photos });
}

/** A read held until `finish` is called. */
function heldRead(): { read: Promise<void>; finish: () => void } {
  let finish = (): void => {};
  const read = new Promise<void>((resolve) => (finish = resolve));
  return { read, finish };
}

function showPreviews(): void {
  render(<PreferencesDialog />);
  act(() => openPreferences("Previews"));
}

const button = (name: string): HTMLButtonElement => screen.getByRole("button", { name });

/** Long enough for a pass that kept going to read every file. */
const runOut = (): Promise<void> => new Promise((r) => setTimeout(r, 100));

beforeEach(() => {
  localStorage.clear();
  reads = [];
  h.project = new AbortController();
  h.asked = 0;
  vi.stubGlobal("BroadcastChannel", SilentChannel);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  updateSettings({ rawCacheEnabled: true });
});

afterEach(() => {
  useCatalogStore.setState({ photos: [] });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Preferences ▸ Previews, across a project switch", () => {
  it("stops Cache all now", async () => {
    const user = userEvent.setup();
    rawsOfTheOpenProject();
    render(<PreferencesDialog />);
    act(() => openPreferences("Previews"));

    await user.click(screen.getByRole("button", { name: "Cache all now" }));
    await runOut();

    expect(h.asked).toBe(1);
    expect(reads).toEqual(["A.NEF"]);
  });

  it("stops Rebuild thumbnails", async () => {
    const user = userEvent.setup();
    rawsOfTheOpenProject();
    render(<PreferencesDialog />);
    act(() => openPreferences("Previews"));

    await user.click(screen.getByRole("button", { name: "Rebuild thumbnails" }));
    await runOut();

    expect(h.asked).toBe(1);
    expect(reads).toEqual(["A.NEF"]);
  });

  // The work already under way can take minutes (a hung decode) to finish.
  it.each(["Cache all now", "Rebuild thumbnails"])(
    "puts %s back to idle as soon as the project is left, and keeps it there",
    async (name) => {
      const user = userEvent.setup();
      const first = heldRead();
      rawsOfTheOpenProject({ firstRead: first.read });
      showPreviews();

      await user.click(button(name));
      await waitFor(() => expect(button(name).disabled).toBe(false));
      expect(screen.getByText("Stopped.")).toBeTruthy();

      first.finish();
      await runOut();
      expect(button(name).disabled).toBe(false);
      expect(screen.getByText("Stopped.")).toBeTruthy();
    },
  );

  it("still says how many it rebuilt when nothing stopped it, even after a later close", async () => {
    const user = userEvent.setup();
    rawsOfTheOpenProject({ switchOnRead: false });
    showPreviews();

    await user.click(button("Rebuild thumbnails"));
    await runOut();

    expect(screen.getByText("Rebuilt 4.")).toBeTruthy();
    expect(screen.queryByText("Stopped.")).toBeNull();

    act(() => h.project.abort()); // the project is closed later
    expect(screen.getByText("Rebuilt 4.")).toBeTruthy();
  });
});
