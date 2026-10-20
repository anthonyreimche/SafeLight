// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A browse card's tag reads "category · type": the first category and the
// type badge, from the registry's fields or, for live results, the topics.

import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ExtensionCard, cardTag } from "./StoreCards";
import { useExtStoreUI } from "./store-ui";
import { FALLBACK_VOCABULARY as V } from "./store-categories";
import type { ExtensionSearchResult } from "./types";

const result = (over: Partial<ExtensionSearchResult> = {}): ExtensionSearchResult => ({
  fullName: "acme/warp",
  description: "Warps.",
  stars: 2,
  updatedAt: "2026-01-01T00:00:00Z",
  ...over,
});

beforeEach(() => useExtStoreUI.setState({ vocabulary: V }));

describe("cardTag", () => {
  it("reads the registry's first category and type", () => {
    expect(cardTag(result({ categories: ["detail", "tone"], type: "pipeline" }), V)).toBe(
      "Detail and repair · Processing",
    );
  });

  it("reads the topics of a live result", () => {
    expect(cardTag(result({ topics: ["safelight-panel", "safelight-library"] }), V)).toBe("Library · Panel");
  });

  it("shows only the part it has, or nothing", () => {
    expect(cardTag(result({ categories: ["look"], type: null }), V)).toBe("Looks");
    expect(cardTag(result({ categories: [], type: "panel" }), V)).toBe("Panel");
    expect(cardTag(result({ categories: [], type: null }), V)).toBe("");
  });
});

describe("ExtensionCard", () => {
  it("shows the tag on the card", () => {
    render(
      <ExtensionCard
        index={0}
        result={result({ categories: ["color"], type: "panel" })}
        thumb={null}
        installing={false}
        disabled={false}
        onOpen={() => {}}
        onInstall={() => {}}
      />,
    );
    screen.getByText("Colour · Panel");
    screen.getByText("warp");
  });
});
