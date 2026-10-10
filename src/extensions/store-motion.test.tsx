// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Extensions store fades its result cards in one after another. That
// cascade is script-driven (Element.animate), so the CSS rule behind the app's
// Reduce motion setting cannot stop it: the card has to check the setting
// itself. The seam is the Electron bridge (window.safelightNative) the panel
// searches through; the real panel and cards render.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { render, screen } from "@testing-library/react";
import { ExtensionManagerPanel } from "@/extensions/ExtensionManagerPanel";
import type { ExtensionSearchResult } from "@/extensions/types";

const RESULT: ExtensionSearchResult = {
  fullName: "acme/widget",
  description: "A widget",
  stars: 3,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-02-01T00:00:00Z",
  source: "registry",
  topics: [],
  avatarUrl: null,
  thumbnail: null,
};

let animate: MockInstance<Element["animate"]>;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("safelightNative", {
    plugins: { list: async () => [], search: async () => [RESULT] },
  });
  animate = vi.spyOn(Element.prototype, "animate");
});

afterEach(() => {
  animate.mockRestore();
  vi.unstubAllGlobals();
  document.documentElement.classList.remove("sl-reduce-motion");
});

async function cardsShown(): Promise<void> {
  render(<ExtensionManagerPanel />);
  await screen.findAllByText("widget");
}

describe("Extensions store card cascade", () => {
  it("fades the cards in by default", async () => {
    await cardsShown();
    expect(animate).toHaveBeenCalled();
  });

  it("does not animate the cards while Reduce motion is on", async () => {
    document.documentElement.classList.add("sl-reduce-motion");
    await cardsShown();
    expect(animate).not.toHaveBeenCalled();
  });

  it("still honours the operating system's reduced-motion preference", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    await cardsShown();
    expect(animate).not.toHaveBeenCalled();
  });
});
