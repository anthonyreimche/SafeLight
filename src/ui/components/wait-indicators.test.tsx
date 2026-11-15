// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The long-wait primitives: an animated ellipsis, a breathing skeleton, and a
// progress bar that can run without a known amount and wait before it shows.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { LoadingDots } from "./LoadingDots";
import { Skeleton } from "./Skeleton";
import { ProgressBar, uiKit } from "@/extensions/ui-kit";

afterEach(() => document.documentElement.classList.remove("sl-reduce-motion"));

describe("LoadingDots", () => {
  it("keeps the label readable and hides the moving dots from screen readers", () => {
    render(<LoadingDots label="Loading" />);
    expect(screen.getByText("Loading")).toBeTruthy();
    const dots = document.querySelector(".sl-dots");
    expect(dots?.getAttribute("aria-hidden")).toBe("true");
    expect(dots?.children).toHaveLength(3);
  });

  it("shows a still ellipsis under Reduce motion", () => {
    document.documentElement.classList.add("sl-reduce-motion");
    render(<LoadingDots label="Loading" />);
    expect(document.querySelector(".sl-dots")).toBeNull();
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("can stand alone without a label", () => {
    render(<LoadingDots />);
    expect(document.querySelector(".sl-dots")).not.toBeNull();
  });
});

describe("Skeleton", () => {
  it("breathes and is hidden from screen readers", () => {
    render(<Skeleton style={{ width: 40, height: 10 }} />);
    const el = document.querySelector(".sl-breathe") as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.getAttribute("aria-hidden")).toBe("true");
    expect(el.style.width).toBe("40px");
  });
});

describe("ProgressBar", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows a known amount as a progressbar with its value and name", () => {
    render(<ProgressBar value={0.25} label="Exporting" />);
    const bar = screen.getByRole("progressbar", { name: "Exporting" });
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
  });

  it("runs without a value when indeterminate", () => {
    render(<ProgressBar indeterminate />);
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
    expect(bar.querySelector(".sl-indeterminate")).not.toBeNull();
  });

  it("waits delayMs before it shows", () => {
    render(<ProgressBar indeterminate delayMs={300} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });

  it("is offered to extensions with the other wait primitives", () => {
    expect(uiKit.ProgressBar).toBe(ProgressBar);
    expect(uiKit.LoadingDots).toBe(LoadingDots);
    expect(uiKit.Skeleton).toBe(Skeleton);
    expect(typeof uiKit.useDelayedFlag).toBe("function");
  });
});
