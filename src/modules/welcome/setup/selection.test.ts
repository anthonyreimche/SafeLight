// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Picks are a set of repos, not of kits: kits overlap, and a kit's tick state
// is derived from its extensions. Installed extensions are never picked and
// never count.

import { describe, expect, it } from "vitest";
import type { TrustList } from "@/extensions/types";
import type { StarterKit } from "./kits";
import {
  kitState,
  pendingInstalls,
  toggleExtension,
  toggleKit,
  visibleKits,
} from "./selection";

const trust = (patch: Partial<TrustList> = {}): TrustList => ({
  verified: [],
  reviewed: {},
  repos: [],
  owners: [],
  reason: {},
  ...patch,
});
const kit = (id: string, repos: string[]): StarterKit => ({
  id,
  name: id,
  description: "",
  icon: null,
  extensions: repos.map((repo) => ({ repo, name: repo.toUpperCase(), summary: "" })),
});
const set = (...repos: string[]) => new Set(repos);
const NONE = set();

describe("visibleKits", () => {
  it("keeps only extensions on the verified list", () => {
    const [shown] = visibleKits(
      [kit("a", ["acme/one", "acme/two"])],
      trust({ verified: ["Acme/One"] }),
    );
    expect(shown.extensions.map((e) => e.repo)).toEqual(["acme/one"]);
  });

  it("removes banned repos and every repo of a banned owner", () => {
    const [shown] = visibleKits(
      [kit("a", ["acme/one", "acme/two", "evil/x"])],
      trust({
        verified: ["acme/one", "acme/two", "evil/x"],
        repos: ["acme/two"],
        owners: ["evil"],
      }),
    );
    expect(shown.extensions.map((e) => e.repo)).toEqual(["acme/one"]);
  });

  it("drops a kit left with nothing", () => {
    expect(
      visibleKits([kit("a", ["acme/one"]), kit("b", ["acme/two"])], trust({ verified: ["acme/two"] })).map((k) => k.id),
    ).toEqual(["b"]);
  });
});

describe("kitState", () => {
  const k = kit("a", ["acme/one", "acme/two"]);

  it("is off with nothing picked", () => {
    expect(kitState(k, NONE, NONE)).toBe("off");
  });

  it("is on with every extension picked", () => {
    expect(kitState(k, set("acme/one", "acme/two"), NONE)).toBe("on");
  });

  it("is mixed with some picked", () => {
    expect(kitState(k, set("acme/two"), NONE)).toBe("mixed");
  });

  it("judges only what isn't installed yet", () => {
    expect(kitState(k, set("acme/two"), set("acme/one"))).toBe("on");
  });

  it("is installed when nothing is left to install", () => {
    expect(kitState(k, NONE, set("acme/one", "acme/two"))).toBe("installed");
  });
});

describe("toggleKit", () => {
  const k = kit("a", ["acme/one", "acme/two"]);

  it("picks every extension of an off kit", () => {
    expect(toggleKit(k, NONE, NONE)).toEqual(set("acme/one", "acme/two"));
  });

  it("completes a mixed kit", () => {
    expect(toggleKit(k, set("acme/one"), NONE)).toEqual(set("acme/one", "acme/two"));
  });

  it("clears an on kit", () => {
    expect(toggleKit(k, set("acme/one", "acme/two"), NONE)).toEqual(NONE);
  });

  it("never picks an installed extension", () => {
    expect(toggleKit(k, NONE, set("acme/one"))).toEqual(set("acme/two"));
  });

  it("leaves other picks alone", () => {
    expect(toggleKit(k, set("other/x"), NONE)).toEqual(
      set("other/x", "acme/one", "acme/two"),
    );
  });

  it("returns a new set", () => {
    const before = set();
    expect(toggleKit(k, before, NONE)).not.toBe(before);
    expect(before.size).toBe(0);
  });
});

describe("toggleExtension", () => {
  it("adds and removes a repo, ignoring case", () => {
    const on = toggleExtension("Acme/One", NONE);
    expect(on).toEqual(set("acme/one"));
    expect(toggleExtension("acme/ONE", on)).toEqual(NONE);
  });
});

describe("an extension shared by two kits", () => {
  it("leaves the other kit mixed when one kit is unticked", () => {
    const a = kit("a", ["acme/one", "acme/shared"]);
    const b = kit("b", ["acme/shared", "acme/two"]);
    let picked = toggleKit(b, toggleKit(a, NONE, NONE), NONE);
    expect(kitState(b, picked, NONE)).toBe("on");
    picked = toggleKit(a, picked, NONE);
    expect(kitState(a, picked, NONE)).toBe("off");
    expect(kitState(b, picked, NONE)).toBe("mixed");
  });
});

describe("pendingInstalls", () => {
  const kits = [
    kit("a", ["acme/one", "acme/shared"]),
    kit("b", ["acme/shared", "acme/two"]),
  ];

  it("lists each picked extension once, in kit order, with its name", () => {
    expect(
      pendingInstalls(kits, set("acme/two", "acme/shared", "acme/one"), NONE),
    ).toEqual([
      { repo: "acme/one", name: "ACME/ONE", summary: "" },
      { repo: "acme/shared", name: "ACME/SHARED", summary: "" },
      { repo: "acme/two", name: "ACME/TWO", summary: "" },
    ]);
  });

  it("skips installed and unpicked extensions", () => {
    expect(
      pendingInstalls(kits, set("acme/one", "acme/shared"), set("acme/one")).map(
        (e) => e.repo,
      ),
    ).toEqual(["acme/shared"]);
  });
});
