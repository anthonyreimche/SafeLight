// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// kits.json is remote data. Whatever the registry publishes, the setup must
// only ever see well-formed kits within the layout's limits, and never an
// extension this build can't run.

import { describe, expect, it } from "vitest";
import { KIT_LIMITS, parseKits } from "./kits";

const APP = "3.0.0";
const ext = (repo: string, extra: Record<string, unknown> = {}) => ({
  repo,
  name: repo.split("/")[1],
  summary: "Does a thing.",
  ...extra,
});
const kit = (
  id: string,
  extensions: unknown,
  extra: Record<string, unknown> = {},
) => ({
  id,
  name: `Kit ${id}`,
  description: "A kit.",
  icon: "film",
  extensions,
  ...extra,
});
const doc = (kits: unknown[]) => ({ schema: 1, kits });
const ids = (raw: unknown) => parseKits(raw, APP)?.map((k) => k.id);

describe("parseKits", () => {
  it("reads a schema-1 document in file order", () => {
    expect(
      parseKits(
        doc([
          kit("film", [ext("Acme/Film-Sim")]),
          kit("colour", [ext("acme/scopes")], { icon: "palette" }),
        ]),
        APP,
      ),
    ).toEqual([
      {
        id: "film",
        name: "Kit film",
        description: "A kit.",
        icon: "film",
        extensions: [
          { repo: "acme/film-sim", name: "Film-Sim", summary: "Does a thing." },
        ],
      },
      {
        id: "colour",
        name: "Kit colour",
        description: "A kit.",
        icon: "palette",
        extensions: [
          { repo: "acme/scopes", name: "scopes", summary: "Does a thing." },
        ],
      },
    ]);
  });

  it.each([
    null,
    "kits",
    [],
    { kits: [] },
    { schema: 2, kits: [] },
    { schema: "1", kits: [] },
    { schema: 1 },
    { schema: 1, kits: {} },
  ])("rejects %j as a kits document", (raw) => {
    expect(parseKits(raw, APP)).toBeNull();
  });

  it("returns no kits for an empty list", () => {
    expect(parseKits(doc([]), APP)).toEqual([]);
  });

  it("drops kits with a bad id, no name, or no extension list", () => {
    expect(
      ids(
        doc([
          kit("Film!", [ext("a/b")]),
          kit("", [ext("a/b")]),
          kit("x".repeat(33), [ext("a/b")]),
          kit("no-name", [ext("a/b")], { name: "   " }),
          kit("no-list", "a/b"),
          { id: "missing", name: "Missing" },
          "kit",
          kit("ok", [ext("a/b")]),
        ]),
      ),
    ).toEqual(["ok"]);
  });

  it("keeps the first of two kits with the same id", () => {
    const kits = parseKits(
      doc([
        kit("film", [ext("a/first")]),
        kit("film", [ext("a/second")]),
      ]),
      APP,
    );
    expect(kits?.map((k) => k.extensions[0].repo)).toEqual(["a/first"]);
  });

  it("drops malformed extensions, and kits left with none", () => {
    const kits = parseKits(
      doc([
        kit("empty", [
          ext("not-a-repo"),
          { repo: "a/b" },
          { repo: "a/c", name: "  " },
          "a/d",
          ext("a/e f"),
        ]),
        kit("some", [ext("bad"), ext("a/ok")]),
      ]),
      APP,
    );
    expect(kits?.map((k) => k.id)).toEqual(["some"]);
    expect(kits?.[0].extensions.map((e) => e.repo)).toEqual(["a/ok"]);
  });

  it("lists a repo once per kit, ignoring case", () => {
    const kits = parseKits(
      doc([kit("a", [ext("Acme/One"), ext("acme/one"), ext("acme/two")])]),
      APP,
    );
    expect(kits?.[0].extensions.map((e) => e.repo)).toEqual([
      "acme/one",
      "acme/two",
    ]);
  });

  it("trims text and cuts it to the limits", () => {
    const long = "x".repeat(500);
    const [parsed] = parseKits(
      doc([
        kit("a", [ext("a/b", { name: `  ${long}`, summary: long })], {
          name: long,
          description: long,
        }),
      ]),
      APP,
    )!;
    expect(parsed.name).toHaveLength(KIT_LIMITS.kitName);
    expect(parsed.description).toHaveLength(KIT_LIMITS.kitDescription);
    expect(parsed.extensions[0].name).toHaveLength(KIT_LIMITS.extensionName);
    expect(parsed.extensions[0].name.startsWith("x")).toBe(true);
    expect(parsed.extensions[0].summary).toHaveLength(
      KIT_LIMITS.extensionSummary,
    );
  });

  it("defaults a missing description and summary to empty text", () => {
    const [parsed] = parseKits(
      doc([kit("a", [{ repo: "a/b", name: "B" }], { description: undefined })]),
      APP,
    )!;
    expect(parsed.description).toBe("");
    expect(parsed.extensions[0].summary).toBe("");
  });

  it("caps the kits and the extensions per kit", () => {
    const many = Array.from({ length: 15 }, (_, i) => ext(`acme/e${i}`));
    const kits = parseKits(
      doc(Array.from({ length: 10 }, (_, i) => kit(`k${i}`, many))),
      APP,
    )!;
    expect(kits).toHaveLength(KIT_LIMITS.kits);
    expect(kits[0].extensions).toHaveLength(KIT_LIMITS.extensionsPerKit);
  });

  it("maps an icon this build doesn't draw to null", () => {
    expect(parseKits(doc([kit("a", [ext("a/b")], { icon: "rocket" })]), APP)?.[0].icon).toBeNull();
    expect(parseKits(doc([kit("a", [ext("a/b")], { icon: undefined })]), APP)?.[0].icon).toBeNull();
  });

  it("hides extensions that need a newer Safelight", () => {
    const kits = parseKits(
      doc([
        kit("a", [
          ext("a/newer", { minAppVersion: "3.0.1" }),
          ext("a/same", { minAppVersion: "3.0.0" }),
          ext("a/older", { minAppVersion: "2.9.0" }),
          ext("a/typo", { minAppVersion: "soon" }),
        ]),
      ]),
      APP,
    );
    expect(kits?.[0].extensions.map((e) => e.repo)).toEqual([
      "a/same",
      "a/older",
      "a/typo",
    ]);
  });
});
