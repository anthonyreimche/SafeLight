// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The store's loading placeholders: status text at once, breathing blocks only
// once the wait lasts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ShelfSkeleton, TextSkeleton } from "./StoreSkeletons";
import { Screenshots } from "./Screenshots";
import { UpdateNotes } from "./ReleaseNotes";
import { useExtStoreUI } from "./store-ui";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("TextSkeleton", () => {
  it("names the wait at once and draws lines after the delay", () => {
    render(<TextSkeleton lines={4} />);
    expect(screen.getByRole("status").textContent).toBe("Loading");
    expect(document.querySelector(".sl-breathe")).toBeNull();
    act(() => vi.advanceTimersByTime(300));
    expect(document.querySelectorAll(".sl-breathe")).toHaveLength(4);
  });
});

describe("ShelfSkeleton", () => {
  it("says Searching and draws card shapes after the delay", () => {
    render(<ShelfSkeleton expanded={false} />);
    expect(screen.getByRole("status").textContent).toBe("Searching");
    expect(document.querySelector(".sl-breathe")).toBeNull();
    act(() => vi.advanceTimersByTime(300));
    expect(document.querySelectorAll(".sl-breathe").length).toBeGreaterThan(5);
  });
});

describe("Screenshots loading", () => {
  it("fades each picture in over a breathing box once it loads", () => {
    render(<Screenshots urls={["https://e.com/a.png"]} />);
    const img = screen.getByAltText("Screenshot 1") as HTMLImageElement;
    expect(img.style.opacity).toBe("0");
    expect(document.querySelector(".sl-breathe")).not.toBeNull();
    fireEvent.load(img);
    expect(img.style.opacity).toBe("1");
    expect(document.querySelector(".sl-breathe")).toBeNull();
  });
});

describe("UpdateNotes loading", () => {
  it("shows skeleton lines while the releases load", () => {
    useExtStoreUI.setState({ releases: { "a/b": { status: "loading" } } });
    render(<UpdateNotes repo="a/b" version="1.0.0" />);
    fireEvent.click(screen.getByRole("button", { name: /What's new/ }));
    expect(screen.getByRole("status").textContent).toBe("Loading");
    act(() => vi.advanceTimersByTime(300));
    expect(document.querySelector(".sl-breathe")).not.toBeNull();
  });
});
