// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The main window's word, once per session, that the image engine can't start on
// this computer, and what still works. WebGL2 is decided through the store; the
// software backend comes from the privileged GPU bridge, faked here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  backend: null as { software: boolean; nextSoftware: boolean; reason: string | null } | null,
  setSoftware: null as unknown as (on: boolean) => Promise<unknown>,
  openReportIssue: null as unknown as (prefill?: { title?: string }) => Promise<void>,
}));

vi.mock("@/native/privileged", () => ({
  privilegedGpu: () =>
    h.backend && {
      backend: async () => h.backend,
      setSoftware: (on: boolean) => h.setSoftware(on),
    },
}));
vi.mock("./report-issue-store", () => ({
  openReportIssue: (prefill?: { title?: string }) => h.openReportIssue(prefill),
}));

import { GraphicsNotice } from "./GraphicsNotice";
import { useGraphics } from "@/state/graphics-store";

const settle = () => act(async () => {});

beforeEach(() => {
  useGraphics.setState({
    webgl2: "no",
    reason: "WebGL2 not supported",
    software: null,
    nextSoftware: null,
    noticeDismissed: false,
  });
  h.backend = null;
  h.setSoftware = vi.fn(async (on: boolean) => ({ software: false, nextSoftware: on, reason: "chosen" }));
  h.openReportIssue = vi.fn(async () => {});
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("GraphicsNotice", () => {
  it("says the engine can't start and what still works, with why in its detail", async () => {
    useGraphics.setState({ reason: "Could not create a WebGL2 context (GPU process gone)" });
    render(<GraphicsNotice />);
    await settle();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(
      "This computer can't run Safelight's image engine. " +
        "You can still browse, rate and organize photos; editing and export need graphics support.",
    );
    expect(alert.textContent).not.toContain("GPU process gone");
    expect(screen.getByTitle("WebGL2 couldn't start: Could not create a WebGL2 context (GPU process gone).")).toBeTruthy();
  });

  it("says nothing when WebGL2 starts", async () => {
    useGraphics.setState({ webgl2: "unknown", reason: null });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      getExtension: () => null,
    } as unknown as RenderingContext);
    render(<GraphicsNotice />);
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers no software rendering where Safelight doesn't choose the backend", async () => {
    render(<GraphicsNotice />);
    await settle();
    expect(screen.queryByRole("button", { name: "Try software rendering" })).toBeNull();
  });

  it("turns software rendering on for the next launch, and says it needs a restart", async () => {
    h.backend = { software: false, nextSoftware: false, reason: null };
    render(<GraphicsNotice />);
    await settle();
    await userEvent.click(screen.getByRole("button", { name: "Try software rendering" }));
    expect(h.setSoftware).toHaveBeenCalledWith(true);
    expect(screen.getByRole("alert").textContent).toContain(
      "Software rendering takes effect when you restart Safelight.",
    );
    expect(screen.queryByRole("button", { name: "Try software rendering" })).toBeNull();
  });

  it("offers no software rendering when this launch already draws in software", async () => {
    h.backend = { software: true, nextSoftware: true, reason: "webgl2-unavailable" };
    render(<GraphicsNotice />);
    await settle();
    expect(screen.queryByRole("button", { name: "Try software rendering" })).toBeNull();
  });

  it("opens Report an issue", async () => {
    render(<GraphicsNotice />);
    await settle();
    await userEvent.click(screen.getByRole("button", { name: "Report an issue" }));
    expect(h.openReportIssue).toHaveBeenCalledTimes(1);
  });

  it("stays dismissed for the session, across remounts", async () => {
    const first = render(<GraphicsNotice />);
    await settle();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
    first.unmount();
    render(<GraphicsNotice />);
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows only in the main window", async () => {
    window.history.replaceState({}, "", "/?detached=library");
    render(<GraphicsNotice />);
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
