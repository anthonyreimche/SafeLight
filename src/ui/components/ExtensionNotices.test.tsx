// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Extension notices are bars in the bottom stack like core's own, each naming
// the extension that speaks, so one can't pass for the app.

import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ExtensionNotices } from "./ExtensionNotices";
import { notify, useNotifications } from "@/state/notification-store";
import { setExtensionName } from "@/extensions/param-registry";

beforeEach(() => {
  useNotifications.setState({ notices: [] });
  setExtensionName("acme.stack", "Stacking Tools");
});

describe("ExtensionNotices", () => {
  it("shows nothing without notices", () => {
    const { container } = render(<ExtensionNotices />);
    expect(container.innerHTML).toBe("");
  });

  it("names the extension beside its message", () => {
    render(<ExtensionNotices />);
    act(() => void notify("acme.stack", "Merged 3 photos."));
    const bar = screen.getByRole("status");
    expect(bar.textContent).toContain("Stacking Tools");
    expect(bar.textContent).toContain("Merged 3 photos.");
  });

  it("announces an error at once", () => {
    render(<ExtensionNotices />);
    act(() => void notify("acme.stack", { message: "Merge failed.", tone: "error" }));
    expect(screen.getByRole("alert").textContent).toContain("Merge failed.");
  });

  it("shows a run's progress", () => {
    render(<ExtensionNotices />);
    act(() => void notify("acme.stack", { message: "Aligning…", progress: 0.25 }));
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
  });

  it("is dismissed with its close button", () => {
    render(<ExtensionNotices />);
    act(() => void notify("acme.stack", { message: "Merge failed.", tone: "error" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
