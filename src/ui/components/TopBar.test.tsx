// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The SAFELIGHT brand text closes the project. Closing keeps every edit, so it
// asks first only when it would cut an import short.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TopBar } from "./TopBar";
import { ConfirmDialogHost } from "./ConfirmDialog";
import { useProjectStore } from "@/project/project-store";

const closeProject = vi.fn();
const original = useProjectStore.getState().closeProject;

beforeEach(() => {
  closeProject.mockClear();
  window.history.replaceState({}, "", "/");
  useProjectStore.setState({ closeProject, opening: false, importDone: 0, importTotal: 0 });
});

afterEach(() => {
  useProjectStore.setState({ closeProject: original, opening: false, importDone: 0, importTotal: 0 });
});

function renderBar() {
  render(
    <>
      <TopBar />
      <ConfirmDialogHost />
    </>,
  );
}

describe("the SAFELIGHT brand text", () => {
  it("closes the project at once when nothing is being imported", async () => {
    renderBar();
    await userEvent.click(screen.getByRole("button", { name: "SAFELIGHT" }));
    expect(closeProject).toHaveBeenCalledTimes(1);
  });

  it("asks before closing a project that is still importing", async () => {
    useProjectStore.setState({ importDone: 40, importTotal: 100 });
    renderBar();
    await userEvent.click(screen.getByRole("button", { name: "SAFELIGHT" }));
    expect(closeProject).not.toHaveBeenCalled();

    await screen.findByRole("dialog", { name: "Close project" });
    await userEvent.click(await screen.findByRole("button", { name: "Close project" }));
    expect(closeProject).toHaveBeenCalledTimes(1);
  });

  it("keeps the project open when the question is declined", async () => {
    useProjectStore.setState({ opening: true });
    renderBar();
    await userEvent.click(screen.getByRole("button", { name: "SAFELIGHT" }));
    await userEvent.click(await screen.findByRole("button", { name: "Keep working" }));
    expect(closeProject).not.toHaveBeenCalled();
  });
});
