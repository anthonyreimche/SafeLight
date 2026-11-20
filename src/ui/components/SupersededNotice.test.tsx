// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The top bar's word that an installed extension was turned off because one
// that replaces it is installed.

import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSupersededNotes } from "@/extensions/supersedes";
import { useExtStoreUI } from "@/extensions/store-ui";
import { SupersededNotice } from "./SupersededNotice";
import { useExtensionsOpen } from "./extensions-dialog-store";

const by = "Framing / Border";

beforeEach(() => {
  localStorage.clear();
  useSupersededNotes.setState({ notes: [] });
  useExtensionsOpen.setState({ open: false });
  useExtStoreUI.setState({ view: "list", selected: null, pendingDetail: null });
});

describe("SupersededNotice", () => {
  it("shows nothing without a notice", () => {
    const { container } = render(<SupersededNotice />);
    expect(container.textContent).toBe("");
  });

  it("names the extension turned off and the one that replaces it", () => {
    useSupersededNotes.setState({ notes: [{ id: "opg.border", name: "Border", by }] });
    render(<SupersededNotice />);
    screen.getByText("Border was disabled — replaced by Framing / Border.");
  });

  it("names every extension one successor replaced in one sentence", () => {
    useSupersededNotes.setState({
      notes: [
        { id: "opg.border", name: "Border", by },
        { id: "opg.print-mat", name: "Print Mat", by },
      ],
    });
    render(<SupersededNotice />);
    screen.getByText("Border and Print Mat were disabled — replaced by Framing / Border.");
  });

  it("goes away when dismissed", async () => {
    useSupersededNotes.setState({ notes: [{ id: "opg.border", name: "Border", by }] });
    const user = userEvent.setup();
    render(<SupersededNotice />);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/was disabled/)).toBeNull();
  });

  it("opens the Extensions window on the extension it turned off", async () => {
    useSupersededNotes.setState({ notes: [{ id: "opg.border", name: "Border", by }] });
    const user = userEvent.setup();
    render(<SupersededNotice />);
    await user.click(screen.getByRole("button", { name: "Manage extensions" }));
    expect(useExtensionsOpen.getState().open).toBe(true);
    expect(useExtStoreUI.getState().pendingDetail).toBe("opg.border");
    expect(screen.queryByText(/was disabled/)).toBeNull();
  });
});
