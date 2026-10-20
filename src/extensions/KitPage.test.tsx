// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A kit's page: what it holds, what's installed, and Install all, which asks
// for the one-time risk acknowledgement first, holds the store busy while it
// runs, and shows each row's outcome, also after leaving and coming back.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialogHost } from "@/ui/components/ConfirmDialog";
import { KitPage } from "./KitPage";
import { useExtStoreUI } from "./store-ui";
import type { InstallDeps } from "@/modules/welcome/setup/install-queue";
import type { StarterKit } from "@/modules/welcome/setup/kits";
import type { ExtensionManifest } from "./types";

const RISK_ACK_KEY = "sl_ext_risk_ack_v1";

const KIT: StarterKit = {
  id: "film",
  name: "Film looks",
  description: "Film stock simulation.",
  icon: "film",
  extensions: [
    { repo: "acme/spektra", name: "Spektrafilm", summary: "Film stocks." },
    { repo: "acme/render", name: "Advanced Rendering", summary: "More renderers." },
    { repo: "acme/match", name: "JPG Tone Match", summary: "Camera look." },
  ],
};

const deps = (patch: Partial<InstallDeps> = {}): InstallDeps => ({
  bannedReason: () => null,
  isVerified: (repo) => repo !== "acme/match",
  checkReview: async () => ({ verified: true, reviewedVersion: null, stale: false, confirmed: true }),
  install: vi.fn(
    async (repo: string): Promise<ExtensionManifest> => ({
      id: repo.replace("/", "."),
      name: repo === "acme/render" ? "Advanced Rendering" : repo,
      version: "1.0.0",
      main: "index.js",
      ...(repo === "acme/render" ? { permissions: { network: ["https://example.com"] } } : {}),
    }),
  ),
  rememberSource: vi.fn(),
  timeoutMs: 1_000,
  where: "its page",
  ...patch,
});

const mount = (props: Partial<Parameters<typeof KitPage>[0]> = {}) => {
  const onBusy = vi.fn();
  const onOpen = vi.fn();
  const onDone = vi.fn();
  const view = render(
    <>
      <KitPage
        kit={KIT}
        installed={new Set(["acme/spektra"])}
        busy={null}
        onBusy={onBusy}
        onOpen={onOpen}
        onDone={onDone}
        deps={deps()}
        {...props}
      />
      <ConfirmDialogHost />
    </>,
  );
  return { onBusy, onOpen, onDone, ...view };
};

beforeEach(() => {
  localStorage.clear();
  useExtStoreUI.setState({ kitRuns: {}, kitRunning: null, kit: "film", browse: "home" });
});

describe("KitPage", () => {
  it("shows the kit, its installed members, and what Install all would fetch", () => {
    mount();
    screen.getByRole("heading", { name: "Film looks" });
    screen.getByText("Film stock simulation.");
    const spektra = screen.getByRole("button", { name: /Spektrafilm/ });
    within(spektra).getByText("Installed");
    screen.getByRole("button", { name: "Install all (2)" });
  });

  it("opens a member's page", async () => {
    const user = userEvent.setup();
    const { onOpen } = mount();
    await user.click(screen.getByRole("button", { name: /JPG Tone Match/ }));
    expect(onOpen).toHaveBeenCalledWith("acme/match");
  });

  it("asks for the risk acknowledgement first; cancelling installs nothing", async () => {
    const d = deps();
    const user = userEvent.setup();
    mount({ deps: d });
    await user.click(screen.getByRole("button", { name: "Install all (2)" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(d.install).not.toHaveBeenCalled();
    expect(localStorage.getItem(RISK_ACK_KEY)).toBeNull();
  });

  it("installs, skips what isn't verified, and reports each row", async () => {
    localStorage.setItem(RISK_ACK_KEY, "1");
    const d = deps();
    const user = userEvent.setup();
    const { onBusy, onDone } = mount({ deps: d });
    await user.click(screen.getByRole("button", { name: "Install all (2)" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onBusy.mock.calls).toEqual([["kit:film"], [null]]);
    expect(d.install).toHaveBeenCalledTimes(1);
    within(screen.getByRole("button", { name: /Advanced Rendering/ })).getByText("Installed");
    const match = screen.getByRole("button", { name: /JPG Tone Match/ });
    within(match).getByText("Skipped");
    within(match).getByText("Not on the verified list any more.");
    screen.getByText("Restart Safelight so Advanced Rendering can reach the internet.");
  });

  it("keeps the outcome after leaving and coming back", async () => {
    localStorage.setItem(RISK_ACK_KEY, "1");
    const user = userEvent.setup();
    const { onDone, unmount } = mount();
    await user.click(screen.getByRole("button", { name: "Install all (2)" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    unmount();
    mount();
    within(screen.getByRole("button", { name: /JPG Tone Match/ })).getByText("Skipped");
  });

  it("lets the real install state replace a settled row once the member is installed", async () => {
    localStorage.setItem(RISK_ACK_KEY, "1");
    const user = userEvent.setup();
    const { onDone, unmount } = mount();
    await user.click(screen.getByRole("button", { name: "Install all (2)" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    within(screen.getByRole("button", { name: /JPG Tone Match/ })).getByText("Skipped");
    unmount();
    mount({ installed: new Set(["acme/spektra", "acme/match"]) });
    const match = screen.getByRole("button", { name: /JPG Tone Match/ });
    within(match).getByText("Installed");
    within(match).getByText("Camera look.");
    expect(within(match).queryByText("Skipped")).toBeNull();
    expect(within(match).queryByText("Not on the verified list any more.")).toBeNull();
  });

  it("is disabled while anything else installs, and says so while it runs itself", () => {
    const { unmount } = mount({ busy: "acme/other" });
    expect((screen.getByRole("button", { name: "Install all (2)" }) as HTMLButtonElement).disabled).toBe(true);
    unmount();
    mount({ busy: "kit:film" });
    expect((screen.getByRole("button", { name: "Installing…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says so while its run continues from a page that has since closed", () => {
    useExtStoreUI.setState({ kitRunning: "film" });
    mount();
    expect((screen.getByRole("button", { name: "Installing…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers no Install all when everything is installed", () => {
    mount({ installed: new Set(KIT.extensions.map((e) => e.repo)) });
    expect(screen.queryByRole("button", { name: /^Install all/ })).toBeNull();
  });

  it("goes back to the Browse home", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "← Browse" }));
    expect(useExtStoreUI.getState()).toMatchObject({ kit: null, browse: "home" });
  });
});
