import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

const openUrl = vi.fn();
vi.mock("@/update/update-checker", () => ({ openUrl: (url: string) => openUrl(url) }));

import { popEscapeHandler } from "@/ui/escape-stack";
import { WhatsNewDialog } from "./WhatsNewDialog";
import { CHANGELOG_URL, closeWhatsNew, useWhatsNew } from "./whats-new-store";

beforeEach(() => {
  openUrl.mockClear();
  closeWhatsNew();
});

test("renders nothing while closed", () => {
  const { container } = render(<WhatsNewDialog />);
  expect(container.innerHTML).toBe("");
});

test("shows each release's version, date and grouped changes, with inline formatting", () => {
  useWhatsNew.setState({
    releases: [
      { version: "3.2.7", date: "2026-11-24", groups: [{ title: "Added", items: ["**Lens Blur** fakes depth of field."] }] },
      { version: "3.2.6", date: null, groups: [{ title: "Fixed", items: ["A crash on open."] }] },
    ],
  });
  render(<WhatsNewDialog />);
  expect(screen.getByRole("heading", { name: /3\.2\.7/ })).toBeTruthy();
  expect(screen.getByRole("heading", { name: /3\.2\.6/ })).toBeTruthy();
  expect(screen.getByText("Lens Blur").tagName).toBe("STRONG");
  expect(screen.getByText("A crash on open.")).toBeTruthy();
  expect(screen.getAllByText("Added")).toHaveLength(1);
});

test("All changes opens the changelog in the browser; Close closes", () => {
  useWhatsNew.setState({ releases: [{ version: "3.2.7", date: null, groups: [{ title: "Fixed", items: ["x"] }] }] });
  render(<WhatsNewDialog />);
  fireEvent.click(screen.getByRole("button", { name: "All changes" }));
  expect(openUrl).toHaveBeenCalledWith(CHANGELOG_URL);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(useWhatsNew.getState().releases).toBeNull();
});

test("Esc closes it through the shared modal stack", () => {
  useWhatsNew.setState({ releases: [{ version: "3.2.7", date: null, groups: [{ title: "Fixed", items: ["x"] }] }] });
  render(<WhatsNewDialog />);
  expect(popEscapeHandler()).toBe(true);
  expect(useWhatsNew.getState().releases).toBeNull();
});
