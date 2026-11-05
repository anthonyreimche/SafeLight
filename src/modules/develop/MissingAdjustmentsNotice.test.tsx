// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Develop says when the open photo uses adjustments from an essential that
// isn't running, since the photo then renders without them.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_DEVELOP_PARAMS } from "@/catalog/types";
import { useDisabledExtensions, useExternalPluginsSettled, useRunningPlugins } from "@/extensions/loader";
import { useExtStoreUI } from "@/extensions/store-ui";
import { useDevelopStore } from "@/state/develop-store";
import { ExtensionsDialog, closeExtensions } from "@/ui/components/ExtensionsDialog";
import { MissingAdjustmentsNotice, resetDismissedAdjustments } from "./MissingAdjustmentsNotice";

const VIGNETTE = { ...DEFAULT_DEVELOP_PARAMS.vignette, amount: -20 };

function setup({ settled = true, running = [] as string[], disabled = [] as string[], vignette = VIGNETTE } = {}) {
  useDevelopStore.setState({
    // Sharpening off, so only the vignette asks for an essential.
    params: { ...DEFAULT_DEVELOP_PARAMS, sharpening: 0, vignette },
    asShotTemperature: DEFAULT_DEVELOP_PARAMS.temperature,
  });
  useExternalPluginsSettled.setState({ settled });
  useRunningPlugins.setState({ ids: running });
  useDisabledExtensions.setState({ ids: disabled });
  return render(<MissingAdjustmentsNotice />);
}

beforeEach(() => {
  resetDismissedAdjustments();
});

afterEach(() => {
  act(() => closeExtensions());
  useDevelopStore.setState({ params: DEFAULT_DEVELOP_PARAMS });
  useExternalPluginsSettled.setState({ settled: false });
  useRunningPlugins.setState({ ids: [] });
  useDisabledExtensions.setState({ ids: [] });
});

describe("MissingAdjustmentsNotice", () => {
  it("names an essential the photo uses that isn't installed", () => {
    setup();
    expect(screen.getByRole("status").textContent).toContain(
      "This photo uses adjustments from Effects, which isn't installed.",
    );
  });

  it("says nothing while extensions are still loading", () => {
    const { container } = setup({ settled: false });
    expect(container.textContent).toBe("");
  });

  it("says nothing when the essential is running", () => {
    const { container } = setup({ running: ["safelight.effects"] });
    expect(container.textContent).toBe("");
  });

  it("says nothing when the photo doesn't use it", () => {
    const { container } = setup({ vignette: DEFAULT_DEVELOP_PARAMS.vignette });
    expect(container.textContent).toBe("");
  });

  it("says when the essential is turned off, and offers to turn it on", () => {
    setup({ disabled: ["safelight.effects"] });
    expect(screen.getByRole("status").textContent).toContain(
      "This photo uses adjustments from Effects, which is turned off.",
    );
    expect(screen.getByRole("button", { name: "Turn on" })).toBeTruthy();
  });

  it("opens the essential's page in Extensions", () => {
    setup();
    render(<ExtensionsDialog />);
    fireEvent.click(screen.getByRole("button", { name: "View in Extensions" }));
    expect(useExtStoreUI.getState()).toMatchObject({ view: "detail", selected: "anthonyreimche/effects" });
  });

  it("stays hidden for the session once dismissed", () => {
    const first = setup();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(first.container.textContent).toBe("");
    first.unmount();
    const again = setup();
    expect(again.container.textContent).toBe("");
  });
});
