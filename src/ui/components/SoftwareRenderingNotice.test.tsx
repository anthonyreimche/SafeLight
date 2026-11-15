// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The main window's word that Safelight moved itself to software rendering, so
// a slow editor has a visible cause and a way back to the graphics card. The
// backend comes from the privileged GPU bridge, faked here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NativeGpuBackendState } from "@/extensions/types";

const h = vi.hoisted(() => ({
  backend: null as NativeGpuBackendState | null,
  setBackend: null as unknown as (choice: string | null) => Promise<NativeGpuBackendState>,
  restart: null as unknown as () => Promise<void>,
  openReportIssue: null as unknown as (prefill?: { title?: string }) => Promise<void>,
}));

vi.mock("@/native/privileged", () => ({
  privilegedGpu: () =>
    h.backend && {
      backend: async () => h.backend,
      setBackend: (choice: string | null) => h.setBackend(choice),
      restart: () => h.restart(),
    },
}));
vi.mock("./report-issue-store", () => ({
  openReportIssue: (prefill?: { title?: string }) => h.openReportIssue(prefill),
}));

import { SoftwareRenderingNotice } from "./SoftwareRenderingNotice";
import { useGraphics } from "@/state/graphics-store";

const LADDER = ["gl", "gles", "swiftshader"];

const fellBack = (reason: NativeGpuBackendState["reason"]): NativeGpuBackendState => ({
  software: true,
  nextSoftware: true,
  reason,
  backend: "swiftshader",
  next: "swiftshader",
  choice: null,
  backends: LADDER,
  revertTo: null,
  reverted: null,
  keepBy: null,
});

const settle = () => act(async () => {});
const notice = () => screen.queryByRole("status");

beforeEach(() => {
  useGraphics.setState({
    webgl2: "yes",
    reason: null,
    software: null,
    nextSoftware: null,
    softwareReason: null,
    noticeDismissed: false,
    softwareNoticeDismissed: false,
  });
  h.backend = fellBack("gpu-crashes");
  h.setBackend = vi.fn(async () => ({ ...fellBack(null), nextSoftware: false, next: "gl" }));
  h.openReportIssue = vi.fn(async () => {});
  h.restart = vi.fn(async () => {});
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SoftwareRenderingNotice", () => {
  it("says Safelight switched to software, why, and that editing is slower", async () => {
    render(<SoftwareRenderingNotice />);
    await settle();
    expect(notice()?.textContent).toContain(
      "Safelight switched to software because the graphics driver kept crashing. " +
        "Editing is much slower than on the graphics card.",
    );
  });

  it.each([
    ["webgl2-unavailable", "Safelight switched to software because the graphics card couldn't run WebGL2."],
    ["renderer-failed", "Safelight switched to software because the graphics driver couldn't run its photo renderer."],
  ] as const)("gives the reason Preferences gives for %s", async (reason, sentence) => {
    h.backend = fellBack(reason);
    render(<SoftwareRenderingNotice />);
    await settle();
    expect(notice()?.textContent).toContain(sentence);
  });

  it("says nothing when the user picked software", async () => {
    h.backend = { ...fellBack("chosen"), choice: "swiftshader" };
    render(<SoftwareRenderingNotice />);
    await settle();
    expect(notice()).toBeNull();
  });

  it("says nothing on the graphics card", async () => {
    h.backend = { ...fellBack(null), software: false, nextSoftware: false, backend: "gles", next: "gles" };
    render(<SoftwareRenderingNotice />);
    await settle();
    expect(notice()).toBeNull();
  });

  it("says nothing where Safelight doesn't choose the backend", async () => {
    h.backend = null;
    render(<SoftwareRenderingNotice />);
    await settle();
    expect(notice()).toBeNull();
  });

  it("leaves a missing WebGL2 to the image engine notice", async () => {
    useGraphics.setState({ webgl2: "no", reason: "WebGL2 not supported" });
    render(<SoftwareRenderingNotice />);
    await settle();
    expect(notice()).toBeNull();
  });

  it("tries the graphics card at the next start, and says it needs a restart", async () => {
    render(<SoftwareRenderingNotice />);
    await settle();
    await userEvent.click(screen.getByRole("button", { name: "Try the graphics card again" }));
    expect(h.setBackend).toHaveBeenCalledWith(null);
    expect(notice()?.textContent).toContain("It tries the graphics card again when you restart Safelight.");
    expect(screen.queryByRole("button", { name: "Try the graphics card again" })).toBeNull();
  });

  it("restarts Safelight once the graphics card is due a try", async () => {
    render(<SoftwareRenderingNotice />);
    await settle();
    expect(screen.queryByRole("button", { name: "Restart Safelight" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Try the graphics card again" }));
    await userEvent.click(screen.getByRole("button", { name: "Restart Safelight" }));
    expect(h.restart).toHaveBeenCalledTimes(1);
  });

  it("says so when the setting couldn't change", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    h.setBackend = vi.fn(async () => {
      throw new Error("ipc closed");
    });
    render(<SoftwareRenderingNotice />);
    await settle();
    await userEvent.click(screen.getByRole("button", { name: "Try the graphics card again" }));
    expect(notice()?.textContent).toContain("Couldn't change the graphics setting.");
  });

  it("a launch already due a try on the graphics card says so, with nothing to press", async () => {
    h.backend = { ...fellBack(null), nextSoftware: false, next: "gl" };
    render(<SoftwareRenderingNotice />);
    await settle();
    expect(notice()?.textContent).toContain(
      "Safelight is drawing in software. Editing is much slower than on the graphics card. " +
        "It tries the graphics card again when you restart Safelight.",
    );
    expect(screen.queryByRole("button", { name: "Try the graphics card again" })).toBeNull();
  });

  it("opens Report an issue", async () => {
    render(<SoftwareRenderingNotice />);
    await settle();
    await userEvent.click(screen.getByRole("button", { name: "Report an issue" }));
    expect(h.openReportIssue).toHaveBeenCalledWith({ title: "Safelight switched to software rendering" });
  });

  it("stays dismissed for the session, across remounts", async () => {
    const first = render(<SoftwareRenderingNotice />);
    await settle();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(notice()).toBeNull();
    first.unmount();
    render(<SoftwareRenderingNotice />);
    await settle();
    expect(notice()).toBeNull();
  });

  it("shows only in the main window", async () => {
    window.history.replaceState({}, "", "/?detached=library");
    render(<SoftwareRenderingNotice />);
    await settle();
    expect(notice()).toBeNull();
  });
});
