// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A graphics backend changed in Preferences that didn't work sends the next
// launch back to the selection that last did. A startup crash relaunches with
// no dialogue, so the main window says which change didn't work and where it
// went back to. The backend comes from the privileged GPU bridge, faked here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NativeGpuBackendState } from "@/extensions/types";

const h = vi.hoisted(() => ({
  backend: null as NativeGpuBackendState | null,
  openReportIssue: null as unknown as (prefill?: { title?: string }) => Promise<void>,
}));

vi.mock("@/native/privileged", () => ({
  privilegedGpu: () => h.backend && { backend: async () => h.backend },
}));
vi.mock("./report-issue-store", () => ({
  openReportIssue: (prefill?: { title?: string }) => h.openReportIssue(prefill),
}));

import { GraphicsRevertNotice } from "./GraphicsRevertNotice";
import { useGraphics } from "@/state/graphics-store";

const wentBack = (over: Partial<NativeGpuBackendState> = {}): NativeGpuBackendState => ({
  software: false,
  nextSoftware: false,
  reason: null,
  backend: "gl",
  next: "gl",
  choice: null,
  backends: ["gl", "gles", "vulkan", "swiftshader"],
  revertTo: null,
  reverted: { from: "vulkan", because: "failed" },
  keepBy: null,
  ...over,
});

const settle = () => act(async () => {});
const notice = () => screen.queryByRole("status");

beforeEach(() => {
  useGraphics.setState({ revert: null, revertNoticeDismissed: false });
  h.backend = wentBack();
  h.openReportIssue = vi.fn(async () => {});
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("GraphicsRevertNotice", () => {
  it("says which change didn't work and what Safelight went back to", async () => {
    render(<GraphicsRevertNotice />);
    await settle();
    expect(notice()?.textContent).toContain(
      "Vulkan didn't work on this computer, so Safelight went back to Automatic.",
    );
  });

  it("names a pick it went back to, and Automatic as the change", async () => {
    h.backend = wentBack({ choice: "gles", backend: "gles", next: "gles", reverted: { from: "auto", because: "failed" } });
    render(<GraphicsRevertNotice />);
    await settle();
    expect(notice()?.textContent).toContain(
      "Automatic didn't work on this computer, so Safelight went back to OpenGL ES.",
    );
  });

  // A window that drew nothing gave no error; nobody pressed Keep in time.
  it("says when a change went back because nobody kept it", async () => {
    h.backend = wentBack({ reverted: { from: "vulkan", because: "unkept" } });
    render(<GraphicsRevertNotice />);
    await settle();
    expect(notice()?.textContent).toContain(
      "Vulkan wasn't kept within 20 seconds, so Safelight went back to Automatic.",
    );
  });

  it("says nothing when no change was undone", async () => {
    h.backend = wentBack({ reverted: null });
    render(<GraphicsRevertNotice />);
    await settle();
    expect(notice()).toBeNull();
  });

  it("says nothing where Safelight doesn't choose the backend", async () => {
    h.backend = null;
    render(<GraphicsRevertNotice />);
    await settle();
    expect(notice()).toBeNull();
  });

  it("goes once the setting is changed again", async () => {
    render(<GraphicsRevertNotice />);
    await settle();
    expect(notice()).not.toBeNull();
    act(() => useGraphics.setState({ revert: null }));
    expect(notice()).toBeNull();
  });

  it("opens Report an issue, naming the backend", async () => {
    render(<GraphicsRevertNotice />);
    await settle();
    await userEvent.click(screen.getByRole("button", { name: "Report an issue" }));
    expect(h.openReportIssue).toHaveBeenCalledWith({ title: "Graphics backend Vulkan didn't work" });
  });

  it("stays dismissed for the session, across remounts", async () => {
    const first = render(<GraphicsRevertNotice />);
    await settle();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(notice()).toBeNull();
    first.unmount();
    render(<GraphicsRevertNotice />);
    await settle();
    expect(notice()).toBeNull();
  });

  it("shows only in the main window", async () => {
    window.history.replaceState({}, "", "/?detached=library");
    render(<GraphicsRevertNotice />);
    await settle();
    expect(notice()).toBeNull();
  });
});
