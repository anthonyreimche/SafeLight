// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// While a project opens and has no root yet, the window shows a veil under the top bar
// instead of an empty grid. Its indicators wait out a quick open.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useProjectStore } from "@/project/project-store";
import { OpeningVeil } from "./OpeningVeil";

vi.mock("./TopBar", () => ({ TopBar: () => <div data-testid="top-bar" /> }));

beforeEach(() => {
  vi.useFakeTimers();
  useProjectStore.setState({ opening: true, root: null, openingName: "Rome", importDone: 0, importTotal: 0 });
});

afterEach(() => {
  vi.useRealTimers();
  useProjectStore.setState({ opening: false, openingName: "", importDone: 0, importTotal: 0 });
});

describe("OpeningVeil", () => {
  it("keeps the top bar and shows nothing extra for a quick open", () => {
    render(<OpeningVeil />);
    expect(screen.getByTestId("top-bar")).toBeTruthy();
    expect(screen.queryByText(/Opening/)).toBeNull();
    expect(document.querySelector(".sl-breathe")).toBeNull();
  });

  it("names the project and breathes skeleton tiles once the wait lasts", () => {
    render(<OpeningVeil />);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByRole("status").textContent).toContain("Opening Rome");
    expect(document.querySelectorAll(".sl-breathe").length).toBeGreaterThan(4);
  });

  it("says plain Opening when the name is unknown", () => {
    useProjectStore.setState({ openingName: "" });
    render(<OpeningVeil />);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByRole("status").textContent).toContain("Opening");
    expect(screen.getByRole("status").textContent).not.toContain("Opening ");
  });

  it("shows a determinate bar once the import total is known", () => {
    render(<OpeningVeil />);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.queryByRole("progressbar")).toBeNull();
    act(() => useProjectStore.setState({ importDone: 25, importTotal: 100 }));
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
  });
});
