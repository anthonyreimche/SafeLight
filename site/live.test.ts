// The website's live registry data (site/live.js), loaded the way a page loads
// it: as a plain script that sets window.SafelightLive.

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";

interface Card {
  name: string;
  repo: string;
  author: string;
  description: string;
  thumbnail: string;
  link: string;
  verified: boolean;
}
interface Live {
  summary(index: unknown, verified: unknown): { extensions: number; developers: number; verified: number };
  popular(index: unknown, verified: unknown, count: number): Card[];
  developers(index: unknown): { login: string; avatar: string; link: string; count: string }[];
  supporters(markdown: string): { name: string; link: string }[];
  library(index: unknown, verified: unknown): (Card & { categories: string; slugs: string })[];
}

const source = readFileSync(new URL("./live.js", import.meta.url), "utf8");
const sandbox: { window: { SafelightLive?: Live } } = { window: {} };
runInNewContext(source, sandbox);
const live = sandbox.window.SafelightLive as Live;

const entry = (fullName: string, over: Record<string, unknown> = {}) => ({
  fullName,
  name: fullName.split("/")[1],
  description: `About ${fullName}`,
  stars: 0,
  updatedAt: "2026-11-01T00:00:00Z",
  avatarUrl: `https://avatars.example/${fullName.split("/")[0]}`,
  thumbnail: { url: `https://img.example/${fullName}.png` },
  ...over,
});

const index = {
  extensions: [
    entry("acme/warp", { downloads: 40 }),
    entry("Acme/glow", { downloads: 90, stars: 1 }),
    entry("zed/old", { downloads: 500, deprecated: { replacedBy: "zed/new", message: null } }),
    entry("bea/tint", { stars: 3, updatedAt: "2026-11-20T00:00:00Z" }),
    entry("bea/grain", { stars: 3, updatedAt: "2026-11-02T00:00:00Z" }),
  ],
};
const verified = { verified: ["acme/glow", { repo: "BEA/tint", version: "1.0.0" }] };

describe("summary", () => {
  test("counts listed extensions, their developers and the verified ones, leaving discontinued ones out", () => {
    expect(live.summary(index, verified)).toEqual({ extensions: 4, developers: 2, verified: 2 });
  });

  test("a missing or malformed index counts nothing", () => {
    expect(live.summary(null, null)).toEqual({ extensions: 0, developers: 0, verified: 0 });
    expect(live.summary({ extensions: "nope" }, { verified: 3 })).toEqual({ extensions: 0, developers: 0, verified: 0 });
  });
});

describe("popular", () => {
  test("most downloaded first, then stars, then most recently updated; discontinued left out", () => {
    expect(live.popular(index, verified, 10).map((c) => c.repo)).toEqual(["Acme/glow", "acme/warp", "bea/tint", "bea/grain"]);
  });

  test("cards carry what a card shows, and are capped", () => {
    const [first] = live.popular(index, verified, 1);
    expect(first).toEqual({
      name: "glow",
      repo: "Acme/glow",
      author: "Acme",
      description: "About Acme/glow",
      thumbnail: "https://img.example/Acme/glow.png",
      link: "https://github.com/Acme/glow",
      verified: true,
    });
    expect(live.popular(index, verified, 2)).toHaveLength(2);
  });

  test("an image that isn't https is dropped rather than shown", () => {
    const odd = { extensions: [entry("acme/warp", { thumbnail: { url: "javascript:alert(1)" } })] };
    expect(live.popular(odd, null, 5)[0].thumbnail).toBe("");
  });
});

describe("library", () => {
  const withCategories = {
    categories: [
      { slug: "tone", label: "Tone" },
      { slug: "color", label: "Colour" },
    ],
    extensions: [
      entry("acme/warp", { name: "warp", categories: ["tone", "color"] }),
      entry("bea/Grain", { name: "Grain", categories: ["mystery"] }),
      entry("zed/old", { deprecated: { replacedBy: null, message: null } }),
      entry("bea/tint", { name: "tint" }),
    ],
  };

  test("every listed extension, A to Z whatever the case, discontinued left out", () => {
    expect(live.library(withCategories, verified).map((c) => c.name)).toEqual(["Grain", "tint", "warp"]);
  });

  test("carries category labels to show and slugs to filter by; unknown slugs show as themselves", () => {
    const cards = live.library(withCategories, verified);
    const warp = cards.find((c) => c.name === "warp");
    expect(warp?.categories).toBe("Tone, Colour");
    expect(warp?.slugs).toBe("tone color");
    expect(cards.find((c) => c.name === "Grain")?.categories).toBe("mystery");
    expect(cards.find((c) => c.name === "tint")).toMatchObject({ categories: "", slugs: "", verified: true });
  });
});

describe("developers", () => {
  test("one row per account, spelled as first seen, alphabetical whatever the case, with how many extensions each has", () => {
    expect(live.developers(index)).toEqual([
      { login: "acme", avatar: "https://avatars.example/acme", link: "https://github.com/acme", count: "2 extensions" },
      { login: "bea", avatar: "https://avatars.example/bea", link: "https://github.com/bea", count: "2 extensions" },
    ]);
  });

  test("one extension reads in the singular", () => {
    expect(live.developers({ extensions: [entry("solo/one")] })[0].count).toBe("1 extension");
  });
});

describe("supporters", () => {
  test("reads the coffee list from SUPPORTERS.md, with links where there are any, alphabetically", () => {
    const md = [
      "# Supporters",
      "",
      "## 🧩 Extension developers",
      "",
      "- [oatbiscuit](https://github.com/oatbiscuit), 5 extensions",
      "",
      "## ☕ Bought a coffee",
      "",
      "- Barrie Minney",
      "- [A. Flech](https://example.com/af)",
      "- ",
      "",
      "Want to join them?",
    ].join("\n");
    expect(live.supporters(md)).toEqual([
      { name: "A. Flech", link: "https://example.com/af" },
      { name: "Barrie Minney", link: "" },
    ]);
  });

  test("no coffee section reads as nobody", () => {
    expect(live.supporters("# Supporters\n\n- someone")).toEqual([]);
  });
});
