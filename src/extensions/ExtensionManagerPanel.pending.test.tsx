// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Clicking Install answers at once: the review check can wait on the network, so
// the card says it is checking while every other control stays usable.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialogHost } from "@/ui/components/ConfirmDialog";
import { ExtensionManagerPanel } from "@/extensions/ExtensionManagerPanel";
import { useExtStoreUI } from "@/extensions/store-ui";
import type { NativePluginsBridge } from "@/extensions/types";
import type { ReviewCheck } from "@/extensions/install-gate";

const gate = vi.hoisted(() => ({
  review: null as null | (() => Promise<ReviewCheck>),
}));
vi.mock("@/extensions/install-gate", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/extensions/install-gate")>();
  return { ...real, checkReview: () => gate.review!() };
});

let privilegedBridge: NativePluginsBridge | null = null;
vi.mock("@/native/privileged", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/native/privileged")>()),
  privilegedPlugins: () => privilegedBridge,
}));

const found = ["acme/one-tool", "acme/two-tool"].map((fullName) => ({
  fullName,
  description: null,
  stars: 1,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  source: "registry" as const,
}));

const unreviewed: ReviewCheck = { verified: false, reviewedVersion: null, stale: false, confirmed: true };

let release!: (review: ReviewCheck) => void;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("sl_ext_risk_ack_v1", "1");
  useExtStoreUI.setState({ browse: "home", railExpanded: false });
  gate.review = () =>
    new Promise<ReviewCheck>((resolve) => {
      release = resolve;
    });
  privilegedBridge = {
    install: vi.fn(async () => ({ id: "acme.one", name: "One", version: "1.0.0", main: "index.js" })),
    uninstall: async () => {},
    settleUpdate: async () => null,
  };
  vi.stubGlobal("safelightNative", {
    plugins: { list: async () => [], search: async () => found },
  });
});

afterEach(() => vi.unstubAllGlobals());

async function openSearch(user: ReturnType<typeof userEvent.setup>) {
  render(
    <>
      <ExtensionManagerPanel />
      <ConfirmDialogHost />
    </>,
  );
  await user.type(screen.getByLabelText("Search official extensions"), "tool");
  await screen.findByText("one-tool");
  return screen.getAllByRole("button", { name: "Install" });
}

describe("ExtensionManagerPanel install pending", () => {
  it("shows Checking on the clicked card while other controls stay enabled", async () => {
    const user = userEvent.setup();
    const [first, second] = await openSearch(user);
    await user.click(first!);

    const pending = await screen.findByText(/Checking/);
    expect(pending.closest("button")).toBeTruthy();
    expect((second as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("textbox", { name: "Search official extensions" }) as HTMLInputElement).disabled).toBe(
      false,
    );

    await act(async () => release(unreviewed));
    const dialog = await screen.findByRole("dialog");
    expect(screen.queryByText(/Checking/)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  });

  it("ignores a second click on the same card while it checks", async () => {
    const calls = vi.fn();
    gate.review = () => {
      calls();
      return new Promise<ReviewCheck>((resolve) => {
        release = resolve;
      });
    };
    const user = userEvent.setup();
    const [first] = await openSearch(user);
    await user.click(first!);
    const pending = (await screen.findByText(/Checking/)).closest("button")!;
    await user.click(pending);
    expect(calls).toHaveBeenCalledTimes(1);
    await act(async () => release(unreviewed));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
  });

  it("keeps another card's check showing when the first one ends", async () => {
    const releases: ((review: ReviewCheck) => void)[] = [];
    gate.review = () =>
      new Promise<ReviewCheck>((resolve) => {
        releases.push(resolve);
      });
    const user = userEvent.setup();
    const [first, second] = await openSearch(user);
    await user.click(first!);
    await user.click(second!);
    await waitFor(() => expect(screen.getAllByText(/Checking/)).toHaveLength(2));

    await act(async () => releases[0]!(unreviewed));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.getAllByText(/Checking/)).toHaveLength(1);

    await act(async () => releases[1]!(unreviewed));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/Checking/)).toBeNull();
  });

  it("is clear again when the person declines the prompt", async () => {
    const user = userEvent.setup();
    const [first] = await openSearch(user);
    await user.click(first!);
    await screen.findByText(/Checking/);
    await act(async () => release(unreviewed));

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText(/Checking/)).toBeNull();
    expect((screen.getAllByRole("button", { name: "Install" })[0] as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("ExtensionManagerPanel search wait", () => {
  it("says Searching in a status while the first results are on the way", async () => {
    vi.stubGlobal("safelightNative", {
      plugins: { list: async () => [], search: () => new Promise(() => {}) },
    });
    render(<ExtensionManagerPanel />);
    expect((await screen.findByRole("status")).textContent).toBe("Searching");
  });
});
