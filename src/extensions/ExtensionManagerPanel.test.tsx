// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Install-flow trust prompts. Native window.confirm suspends Electron's
// renderer and can desync window focus (keystrokes stop reaching inputs until
// refocus/restart — electron#31917), so the trust gates must run through the
// in-app confirmDialog. These tests drive the custom-repo import journey and
// pin that window.confirm is never invoked along the way. The seam is the
// Electron bridge (window.safelightNative): the real loader runs, and reaching
// plugins.install is the "install proceeded" signal. The bundle activation
// that follows needs the app:// protocol and is out of jsdom's reach.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialogHost } from "@/ui/components/ConfirmDialog";
import { ExtensionManagerPanel } from "@/extensions/ExtensionManagerPanel";

const RISK_ACK_KEY = "sl_ext_risk_ack_v1";

let installBridge: Mock;
let confirmSpy: MockInstance<Window["confirm"]>;

beforeEach(() => {
  localStorage.clear();
  // Bridge present ⇒ the panel opens on Browse, where the custom-repo importer
  // lives. No trustList ⇒ nothing is verified, so the import takes the
  // unreviewed path under test.
  installBridge = vi.fn(async () => ({
    id: "acme.widget",
    name: "Widget",
    version: "1.0.0",
    main: "index.js",
  }));
  vi.stubGlobal("safelightNative", {
    plugins: { list: async () => [], install: installBridge },
  });
  // Answering "yes" keeps the legacy native path observable rather than crashing
  // on jsdom's unimplemented confirm — the assertion is that it never runs.
  confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  confirmSpy.mockRestore();
});

const mountStore = () =>
  render(
    <>
      <ExtensionManagerPanel />
      <ConfirmDialogHost />
    </>,
  );

const importRepo = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(
    screen.getByLabelText("Install extension from GitHub (owner/repo, branch, or URL)"),
    "acme/widget",
  );
  await user.click(screen.getByRole("button", { name: "Import" }));
};

describe("ExtensionManagerPanel install trust prompts", () => {
  it("runs both trust gates through the in-app dialog, never window.confirm", async () => {
    const user = userEvent.setup();
    mountStore();
    await importRepo(user);

    const ack = await screen.findByRole("dialog");
    within(ack).getByText(/third-party software/);
    await user.click(within(ack).getByRole("button", { name: "Continue" }));

    const unreviewed = await screen.findByRole("dialog");
    within(unreviewed).getByText(/hasn't been reviewed/);
    await user.click(within(unreviewed).getByRole("button", { name: "Install anyway" }));

    await waitFor(() => expect(installBridge).toHaveBeenCalledWith("acme/widget"));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem(RISK_ACK_KEY)).toBe("1");
  });

  it("cancelling the risk acknowledgment aborts the install", async () => {
    const user = userEvent.setup();
    mountStore();
    await importRepo(user);

    const ack = await screen.findByRole("dialog");
    await user.click(within(ack).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(installBridge).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem(RISK_ACK_KEY)).toBeNull();
  });

  it("a recorded risk acknowledgment goes straight to the unreviewed prompt", async () => {
    localStorage.setItem(RISK_ACK_KEY, "1");
    const user = userEvent.setup();
    mountStore();
    await importRepo(user);

    const unreviewed = await screen.findByRole("dialog");
    within(unreviewed).getByText(/hasn't been reviewed/);
    await user.click(within(unreviewed).getByRole("button", { name: "Install anyway" }));

    await waitFor(() => expect(installBridge).toHaveBeenCalledWith("acme/widget"));
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
