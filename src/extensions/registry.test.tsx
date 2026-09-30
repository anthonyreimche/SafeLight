// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Extension-contributed modules: the tab order, built-in protection, labels,
// and the per-extension sweep. Lives in the dom project because the registry's
// import graph reaches stores that expect a window.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  moduleLabel,
  moduleTabs,
  registerModule,
  unregisterExtension,
  useRegistry,
} from "./registry";

const View = () => null;

beforeEach(() => {
  useRegistry.setState({ modules: {} });
});

describe("registerModule", () => {
  it("lists the built-ins first, then registered modules by order, then label", () => {
    registerModule("ext.a", { id: "slideshow", label: "Slideshow", component: View, order: 200 });
    registerModule("ext.b", { id: "map", label: "Map", component: View, order: 100 });
    registerModule("ext.c", { id: "book", label: "Book", component: View, order: 100 });
    expect(moduleTabs().map((m) => m.id)).toEqual([
      "library",
      "develop",
      "book",
      "map",
      "slideshow",
    ]);
  });

  it("refuses the built-in ids", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerModule("ext", { id: "library", label: "Not Library", component: View });
    registerModule("ext", { id: "develop", label: "Not Develop", component: View });
    expect(useRegistry.getState().modules).toEqual({});
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("refuses an id that its pop-out window's URL and name cannot carry", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const id of ["My Map", "", "a&b", "a b"])
      registerModule("ext", { id, label: "Map", component: View });
    expect(useRegistry.getState().modules).toEqual({});
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });

  it("re-registering an id replaces the earlier contribution", () => {
    registerModule("ext", { id: "map", label: "Map", component: View });
    registerModule("ext", { id: "map", label: "Map 2", component: View });
    expect(moduleTabs().filter((m) => m.id === "map").map((m) => m.label)).toEqual(["Map 2"]);
  });

  it("labels built-ins and registered modules, and falls back to the id", () => {
    registerModule("ext", { id: "map", label: "Map", component: View });
    expect(moduleLabel("library")).toBe("Library");
    expect(moduleLabel("develop")).toBe("Develop");
    expect(moduleLabel("map")).toBe("Map");
    expect(moduleLabel("print")).toBe("print");
  });

  it("is swept with the rest of the extension's contributions", () => {
    registerModule("ext", { id: "map", label: "Map", component: View });
    registerModule("other", { id: "book", label: "Book", component: View });
    unregisterExtension("ext");
    expect(moduleTabs().map((m) => m.id)).toEqual(["library", "develop", "book"]);
  });
});
