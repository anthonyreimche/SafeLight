// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// api.variables as extensions get it, and the sweep on disable. In the dom
// project because host.tsx's import graph reaches stores that expect a window.

import { afterEach, describe, expect, it, vi } from "vitest";
import { makeScopedAPI } from "./host";
import { unregisterExtension } from "./registry";
import { windowLabel } from "./variables-host";

afterEach(() => vi.restoreAllMocks());

describe("api.variables", () => {
  it("is scoped per extension", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = makeScopedAPI("var-a").variables;
    const b = makeScopedAPI("var-b").variables;
    a.register("var-test.one", { initial: 1 });
    expect(b.get("var-test.one")?.registeredBy.extension).toBe("var-a");
    expect(b.set("var-test.one", 2)).toMatchObject({ ok: true });
    expect(a.set("var-test.one", 3)).toMatchObject({ ok: false, reason: "stale" });
  });

  it("stops delivering to an extension once it is swept", () => {
    const a = makeScopedAPI("var-c").variables;
    const got: number[] = [];
    a.register("var-test.two", { initial: 0 });
    a.subscribe<number>("var-test.two", (s) => void got.push(s.value));
    unregisterExtension("var-c");
    makeScopedAPI("var-d").variables.update<number>("var-test.two", (n) => n + 1);
    expect(got).toEqual([0]);
  });
});

describe("windowLabel", () => {
  it("names this window for the others' history and reports", () => {
    expect(windowLabel("")).toBe("main");
    expect(windowLabel("?detached=map")).toBe("map");
    expect(windowLabel("?devtools=1")).toBe("Developer Tools");
  });
});
