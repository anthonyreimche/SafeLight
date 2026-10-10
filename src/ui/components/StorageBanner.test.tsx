// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StorageBanner } from "./StorageBanner";
import { useProjectStore } from "@/project/project-store";

beforeEach(() => {
  useProjectStore.setState({
    openError: null,
    openErrorReadOnly: false,
    storageNotice: null,
    saveError: null,
  });
});

describe("StorageBanner", () => {
  it("offers Preferences when a folder couldn't be opened because it is read-only", () => {
    useProjectStore.setState({
      openError: "Couldn't open “Card”: Safelight couldn't write to the catalog location.",
      openErrorReadOnly: true,
    });

    render(<StorageBanner />);

    expect(screen.getByRole("alert").textContent).toContain("Couldn't open “Card”");
    expect(screen.getByRole("button", { name: "Preferences" })).toBeTruthy();
  });

  it("offers no Preferences when the catalog couldn't be read", () => {
    // Nothing in Preferences helps while another program holds the file.
    useProjectStore.setState({
      openError: "Couldn't open “Shoot”: its catalog can't be read right now (EBUSY).",
      openErrorReadOnly: false,
    });

    render(<StorageBanner />);

    expect(screen.getByRole("alert").textContent).toContain("can't be read right now");
    expect(screen.queryByRole("button", { name: "Preferences" })).toBeNull();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });

  it("shows a save that failed, and can't be dismissed while saves fail", () => {
    // It goes by itself once a save lands.
    useProjectStore.setState({ saveError: "Couldn't save the catalog: the disk is full" });

    render(<StorageBanner />);

    expect(screen.getByRole("alert").textContent).toContain(
      "Couldn't save the catalog: the disk is full",
    );
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("puts a folder that couldn't be opened before a save that failed", () => {
    useProjectStore.setState({
      openError: "Couldn't open “Shoot”: its catalog can't be read right now (EBUSY).",
      saveError: "Couldn't save the catalog: the disk is full",
    });

    render(<StorageBanner />);

    expect(screen.getByRole("alert").textContent).toContain("Couldn't open “Shoot”");
  });

  it("puts a save that failed before a notice", () => {
    useProjectStore.setState({
      saveError: "Couldn't save the catalog: the disk is full",
      storageNotice: "The catalog of “Shoot” couldn't be used, so Safelight restored it.",
    });

    render(<StorageBanner />);

    expect(screen.getByRole("alert").textContent).toContain("Couldn't save the catalog");
    expect(screen.queryByText(/restored it/)).toBeNull();
  });
});
