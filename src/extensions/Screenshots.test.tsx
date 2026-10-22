// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The detail page's screenshot strip: a failed image drops out, and the strip
// with it when none are left; a click enlarges one, ←/→ step through them,
// and Esc or a click closes it. While one is enlarged the global shortcuts are
// suspended, so Esc and the arrows act on it alone (not on the Extensions
// window or the photo behind it).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { photo } from "@/catalog/stored-edit.fixtures";
import { NO_FILTER } from "@/modules/library/visible-photos";
import { useCatalogStore } from "@/state/catalog-store";
import { setShortcutsSuspended, shortcutsSuspended } from "@/state/keybindings-store";
import { useUIStore } from "@/state/ui-store";
import { pushEscapeHandler } from "@/ui/escape-stack";
import { Screenshots } from "./Screenshots";

const URLS = ["https://e.com/a.png", "https://e.com/b.png", "https://e.com/c.png"];

describe("Screenshots", () => {
  it("shows each screenshot", () => {
    render(<Screenshots urls={URLS} />);
    expect(screen.getAllByRole("img")).toHaveLength(3);
  });

  it("drops a screenshot that fails to load, and the strip when none are left", () => {
    const { container } = render(<Screenshots urls={URLS.slice(0, 2)} />);
    fireEvent.error(screen.getByAltText("Screenshot 1"));
    expect(screen.getAllByRole("img")).toHaveLength(1);
    fireEvent.error(screen.getByAltText("Screenshot 1"));
    expect(container.firstChild).toBeNull();
  });

  it("enlarges one, steps with the arrow keys, and closes with Esc or a click", async () => {
    const user = userEvent.setup();
    render(<Screenshots urls={URLS} />);
    await user.click(screen.getByRole("button", { name: "Enlarge screenshot 2" }));
    screen.getByRole("dialog", { name: "Screenshot 2 of 3" });
    await user.keyboard("{ArrowRight}");
    screen.getByRole("dialog", { name: "Screenshot 3 of 3" });
    await user.keyboard("{ArrowRight}");
    screen.getByRole("dialog", { name: "Screenshot 1 of 3" });
    await user.keyboard("{ArrowLeft}");
    screen.getByRole("dialog", { name: "Screenshot 3 of 3" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Enlarge screenshot 1" }));
    await user.click(screen.getByRole("dialog"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders nothing without screenshots", () => {
    const { container } = render(<Screenshots urls={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

// The real global handler, mounted the way the app mounts it at startup.
function WithShortcuts({ urls }: { urls: string[] }) {
  useKeyboardShortcuts();
  return <Screenshots urls={urls} />;
}

class SilentChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

const INITIAL_CATALOG = useCatalogStore.getState();
const INITIAL_UI = useUIStore.getState();

const enlarge = (n: number) => screen.getByRole("button", { name: `Enlarge screenshot ${n}` });

describe("Screenshots while enlarged", () => {
  let unpush: (() => void) | null = null;

  beforeEach(() => {
    vi.stubGlobal("BroadcastChannel", SilentChannel);
  });

  afterEach(() => {
    unpush?.();
    unpush = null;
    vi.unstubAllGlobals();
    setShortcutsSuspended(false);
    useCatalogStore.setState(INITIAL_CATALOG, true);
    useUIStore.setState(INITIAL_UI, true);
  });

  it("suspends the global shortcuts while enlarged and restores them on Esc", async () => {
    const user = userEvent.setup();
    render(<Screenshots urls={URLS} />);
    expect(shortcutsSuspended()).toBe(false);
    await user.click(enlarge(2));
    expect(shortcutsSuspended()).toBe(true);
    await user.keyboard("{Escape}");
    expect(shortcutsSuspended()).toBe(false);
  });

  it("Esc closes the enlarged view but not the Extensions window behind it", async () => {
    const user = userEvent.setup();
    const closeExtensions = vi.fn();
    unpush = pushEscapeHandler(closeExtensions);
    render(<WithShortcuts urls={URLS} />);
    await user.click(enlarge(2));
    await user.keyboard("{Escape}");
    expect(closeExtensions).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("unmounting while enlarged restores the global shortcuts", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Screenshots urls={URLS} />);
    await user.click(enlarge(1));
    expect(shortcutsSuspended()).toBe(true);
    unmount();
    expect(shortcutsSuspended()).toBe(false);
  });

  it("the arrows step the enlarged view, not the photo behind it in Develop", async () => {
    const user = userEvent.setup();
    useUIStore.setState({
      activeModule: "develop",
      sortField: "filename",
      sortDirection: "asc",
      activeFolder: null,
      filter: NO_FILTER,
    });
    useCatalogStore.setState({
      photos: ["a", "b", "c"].map((id) => photo(id)),
      selectedIds: new Set(["a"]),
      activePhotoId: "a",
    });
    render(<WithShortcuts urls={URLS} />);
    await user.click(enlarge(1));
    await user.keyboard("{ArrowRight}");
    screen.getByRole("dialog", { name: "Screenshot 2 of 3" });
    expect(useCatalogStore.getState().activePhotoId).toBe("a");
  });

  it("the enlarged view shows the screenshot that was clicked", async () => {
    const user = userEvent.setup();
    render(<Screenshots urls={URLS} />);
    await user.click(enlarge(2));
    const img = within(screen.getByRole("dialog")).getByRole("img");
    expect(img.getAttribute("src")).toBe("https://e.com/b.png");
  });

  it("losing the enlarged screenshot closes the viewer and restores the global shortcuts", async () => {
    const user = userEvent.setup();
    render(<Screenshots urls={URLS} />);
    await user.click(enlarge(2));
    fireEvent.error(within(enlarge(2)).getByRole("img"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(shortcutsSuspended()).toBe(false);
  });

  it("an earlier screenshot failing keeps the same one enlarged", async () => {
    const user = userEvent.setup();
    render(<Screenshots urls={URLS} />);
    await user.click(enlarge(2));
    fireEvent.error(within(enlarge(1)).getByRole("img"));
    const dialog = screen.getByRole("dialog", { name: "Screenshot 1 of 2" });
    expect(within(dialog).getByRole("img").getAttribute("src")).toBe("https://e.com/b.png");
  });
});
