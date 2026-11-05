// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A render error nothing closer contains must not leave the window blank: the
// root says the window hit an error and offers a reload. Boot's side effects
// are stubbed so only the render is real.

import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./App", () => ({
  App: () => {
    throw new Error("boom");
  },
}));
vi.mock("./native/privileged", () => ({
  claimPrivileged: vi.fn(),
  privilegedOsOpen: () => null,
}));
vi.mock("./extensions/host", () => ({ initExtensionHost: vi.fn() }));
vi.mock("./dev/key-diag", () => ({ installKeyDiag: vi.fn() }));
vi.mock("./diagnostics/error-log", () => ({
  installErrorLog: vi.fn(),
  syncNativeCrashes: vi.fn(async () => {}),
}));

describe("the window's root", () => {
  it("replaces a tree that throws with a notice and a reload button", async () => {
    // React still logs an error a boundary caught.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    document.body.innerHTML = '<div id="root"></div>';

    await act(async () => {
      await import("./main");
    });

    expect(screen.getByRole("alert").textContent).toContain("This window hit an error.");
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    error.mockRestore();
  });
});
