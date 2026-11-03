// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Grid cells and list rows are keyboard-reachable options: one tab stop (the
// active photo), Enter opens, focus follows the active photo, and flags are
// named and distinct without relying on colour.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import type { CatalogPhoto } from "@/catalog/types";

vi.mock("@/state/thumbnail-loader", () => ({ requestThumbnail: vi.fn() }));

import { LibraryListRow } from "@/modules/library/LibraryListRow";
import { Thumbnail } from "./Thumbnail";

function photo(over: Partial<CatalogPhoto> = {}): CatalogPhoto {
  return {
    id: "p1",
    filename: "p1.NEF",
    relPath: "p1.NEF",
    folder: "",
    directoryHandle: null,
    fileHandle: null,
    thumbnailBlob: null,
    thumbnailUrl: "blob:a11y",
    width: 6000,
    height: 4000,
    fileSize: 1024,
    mimeType: "image/x-nikon-nef",
    rating: 0,
    colorLabel: "none",
    flag: "none",
    rotation: 0,
    keywords: [],
    dateCreated: 0,
    dateImported: 0,
    exif: {},
    ...over,
  };
}

interface Flags {
  selected?: boolean;
  active?: boolean;
  onDoubleClick?: (id: string) => void;
}

const kinds = [
  {
    name: "Thumbnail",
    cell: (p: CatalogPhoto, f: Flags = {}) => (
      <Thumbnail
        photo={p}
        selected={f.selected ?? false}
        active={f.active ?? false}
        size={120}
        onClick={() => {}}
        onDoubleClick={f.onDoubleClick}
      />
    ),
  },
  {
    name: "LibraryListRow",
    cell: (p: CatalogPhoto, f: Flags = {}) => (
      <LibraryListRow
        photo={p}
        selected={f.selected ?? false}
        active={f.active ?? false}
        onClick={() => {}}
        onDoubleClick={f.onDoubleClick ?? (() => {})}
      />
    ),
  },
];

beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

describe.each(kinds)("$name as a listbox option", ({ cell }) => {
  const option = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-photo-id]")!;

  it("is an option that reports whether it is selected", () => {
    const { container, rerender } = render(cell(photo()));
    expect(option(container).getAttribute("role")).toBe("option");
    expect(option(container).getAttribute("aria-selected")).toBe("false");
    rerender(cell(photo(), { selected: true }));
    expect(option(container).getAttribute("aria-selected")).toBe("true");
  });

  it("is the one tab stop only while it is the active photo", () => {
    const { container, rerender } = render(cell(photo()));
    expect(option(container).tabIndex).toBe(-1);
    rerender(cell(photo(), { active: true }));
    expect(option(container).tabIndex).toBe(0);
  });

  it("opens on Enter like a double-click", () => {
    const onDoubleClick = vi.fn();
    const { container } = render(cell(photo({ id: "open" }), { onDoubleClick }));
    fireEvent.keyDown(option(container), { key: "Enter" });
    expect(onDoubleClick).toHaveBeenCalledWith("open");
  });

  it("leaves other keys to the global shortcuts", () => {
    const onDoubleClick = vi.fn();
    const { container } = render(cell(photo(), { onDoubleClick }));
    const notPrevented = fireEvent.keyDown(option(container), { key: "ArrowRight" });
    expect(notPrevented).toBe(true);
    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  it("takes focus when it becomes active while a sibling option holds focus", () => {
    const { container, rerender } = render(
      <div>
        {cell(photo({ id: "a" }), { active: true })}
        {cell(photo({ id: "b" }))}
      </div>,
    );
    const [a, b] = Array.from(container.querySelectorAll<HTMLElement>("[data-photo-id]"));
    a.focus();
    rerender(
      <div>
        {cell(photo({ id: "a" }))}
        {cell(photo({ id: "b" }), { active: true })}
      </div>,
    );
    expect(document.activeElement).toBe(b);
  });

  // The Library grid and a Filmstrip each render a cell for the active photo.
  it("keeps focus in its own listbox when another listbox shows the same photos", () => {
    const groups = (active: string) => (
      <div>
        {["grid", "strip"].map((name) => (
          <div key={name} role="listbox" aria-label={name}>
            {cell(photo({ id: "a" }), { active: active === "a" })}
            {cell(photo({ id: "b" }), { active: active === "b" })}
          </div>
        ))}
      </div>
    );
    const { container, rerender } = render(groups("a"));
    const [grid, strip] = Array.from(container.querySelectorAll<HTMLElement>("[role='listbox']"));
    grid.querySelector<HTMLElement>("[data-photo-id='a']")!.focus();
    rerender(groups("b"));
    expect(document.activeElement).toBe(grid.querySelector("[data-photo-id='b']"));
    expect(strip.contains(document.activeElement)).toBe(false);
  });

  it("does not steal focus from outside the grid", () => {
    const { container, rerender } = render(
      <div>
        <button>outside</button>
        {cell(photo())}
      </div>,
    );
    const outside = container.querySelector("button")!;
    outside.focus();
    rerender(
      <div>
        <button>outside</button>
        {cell(photo(), { active: true })}
      </div>,
    );
    expect(document.activeElement).toBe(outside);
  });

  it("names a pick and a reject, and draws them differently", () => {
    const pick = render(cell(photo({ flag: "pick" })));
    const pickBadge = pick.getByLabelText("Pick");
    pick.unmount();
    const reject = render(cell(photo({ flag: "reject" })));
    const rejectBadge = reject.getByLabelText("Rejected");
    expect(rejectBadge.textContent).not.toBe(pickBadge.textContent);
  });

  it("hides decorative glyphs from assistive tech", () => {
    const { container } = render(cell(photo({ thumbnailUrl: null, keywords: ["a", "b"] })));
    const glyphs = Array.from(container.querySelectorAll("[aria-hidden='true']")).map(
      (e) => e.textContent,
    );
    expect(glyphs.join("")).toContain("🏷");
  });
});
