// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The store's rail: Browse's category list is hidden until asked for. The
// chevron only shows or hides it; the Browse label opens the home page and
// shows it; a category row opens that category. Other is listed only when
// something has no category.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoreRail, type StoreSection } from "./StoreRail";
import { useExtStoreUI } from "./store-ui";
import { FALLBACK_VOCABULARY } from "./store-categories";

const mount = (over: Partial<Parameters<typeof StoreRail>[0]> = {}) => {
  const onSection = vi.fn<(s: StoreSection) => void>();
  render(
    <StoreRail
      sections={["Updates", "Browse", "Installed"]}
      section="Browse"
      onSection={onSection}
      categories
      showOther={false}
      {...over}
    />,
  );
  return { onSection };
};

beforeEach(() =>
  useExtStoreUI.setState({
    browse: "home",
    railExpanded: false,
    vocabulary: FALLBACK_VOCABULARY,
    view: "list",
    selected: null,
  }),
);

describe("StoreRail", () => {
  it("starts with the category list hidden", () => {
    mount();
    expect(screen.queryByRole("button", { name: "Library" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show categories" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("shows and hides the list with the chevron, without navigating", async () => {
    const user = userEvent.setup();
    const { onSection } = mount();
    await user.click(screen.getByRole("button", { name: "Show categories" }));
    screen.getByRole("button", { name: "Detail and repair" });
    expect(screen.getByRole("button", { name: "Hide categories" }).getAttribute("aria-expanded")).toBe("true");
    expect(onSection).not.toHaveBeenCalled();
    expect(useExtStoreUI.getState().browse).toBe("home");
    await user.click(screen.getByRole("button", { name: "Hide categories" }));
    expect(screen.queryByRole("button", { name: "Detail and repair" })).toBeNull();
  });

  it("opens the home page and shows the list from the Browse label", async () => {
    useExtStoreUI.setState({ browse: "tone" });
    const user = userEvent.setup();
    const { onSection } = mount({ section: "Installed" });
    await user.click(screen.getByRole("button", { name: "Browse" }));
    expect(onSection).toHaveBeenCalledWith("Browse");
    expect(useExtStoreUI.getState()).toMatchObject({ browse: "home", railExpanded: true });
    screen.getByRole("button", { name: "Tone" });
  });

  it("opens a category from its row and marks it current", async () => {
    useExtStoreUI.setState({ railExpanded: true });
    const user = userEvent.setup();
    const { onSection } = mount();
    await user.click(screen.getByRole("button", { name: "Tone" }));
    expect(onSection).toHaveBeenCalledWith("Browse");
    expect(useExtStoreUI.getState().browse).toBe("tone");
    expect(screen.getByRole("button", { name: "Tone" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Browse" }).getAttribute("aria-current")).toBeNull();
  });

  it("lists Other only when something has no category", () => {
    useExtStoreUI.setState({ railExpanded: true });
    const { unmount } = render(
      <StoreRail sections={["Browse"]} section="Browse" onSection={() => {}} categories showOther={false} />,
    );
    expect(screen.queryByRole("button", { name: "Other" })).toBeNull();
    unmount();
    mount({ showOther: true });
    screen.getByRole("button", { name: "Other" });
  });

  it("marks Browse current when the list is hidden over an open category", () => {
    useExtStoreUI.setState({ browse: "tone", railExpanded: false });
    mount();
    expect(screen.getByRole("button", { name: "Browse" }).getAttribute("aria-current")).toBe("page");
  });

  it("has no chevron or list without categories, and shows the Updates badge", () => {
    mount({ categories: false, badges: { Updates: 3 } });
    expect(screen.queryByRole("button", { name: "Show categories" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Updates/ }).textContent).toBe("Updates3");
  });
});
