// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// @vitest-environment jsdom

// A theme's window material reaches the window through the privileged bridge,
// and a plain theme or reduced transparency takes it away again.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const setMaterial: Mock<(material: "acrylic" | "mica" | null) => Promise<boolean>> = vi.fn(
  async () => true,
);

vi.mock("@/native/privileged", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/native/privileged")>()),
  privilegedWindow: () => ({ setMaterial }),
}));

import { applyTheme, syncWindowMaterial } from "./themes";
import { registerTheme, unregisterExtension } from "./registry";

const OWNER = "test.glass";

beforeEach(async () => {
  registerTheme(OWNER, { id: "test.glass", name: "Glass", vars: {}, window: { material: "mica" } });
  registerTheme(OWNER, { id: "test.plain", name: "Plain", vars: {} });
  applyTheme("test.plain");
  await Promise.resolve();
  setMaterial.mockClear();
  document.documentElement.className = "";
});

afterEach(() => {
  unregisterExtension(OWNER);
  document.documentElement.className = "";
});

describe("window material", () => {
  it("asks for a theme's material", async () => {
    applyTheme("test.glass");
    expect(setMaterial).toHaveBeenLastCalledWith("mica");
    await Promise.resolve();
    expect(document.documentElement.classList.contains("sl-material")).toBe(true);
  });

  it("clears it when a plain theme takes over", async () => {
    applyTheme("test.glass");
    applyTheme("test.plain");
    expect(setMaterial).toHaveBeenLastCalledWith(null);
    await Promise.resolve();
    expect(document.documentElement.classList.contains("sl-material")).toBe(false);
  });

  it("is withheld while transparency is reduced", () => {
    applyTheme("test.glass");
    document.documentElement.classList.add("sl-opaque");
    syncWindowMaterial();
    expect(setMaterial).toHaveBeenLastCalledWith(null);
  });

  it("comes back when reduced transparency is turned off", () => {
    document.documentElement.classList.add("sl-opaque");
    applyTheme("test.glass");
    document.documentElement.classList.remove("sl-opaque");
    syncWindowMaterial();
    expect(setMaterial).toHaveBeenLastCalledWith("mica");
  });

  it("leaves the root opaque when the window could not draw it", async () => {
    setMaterial.mockResolvedValueOnce(false);
    applyTheme("test.glass");
    await Promise.resolve();
    expect(document.documentElement.classList.contains("sl-material")).toBe(false);
  });

  it("leaves the root opaque when asking the window fails", async () => {
    setMaterial.mockRejectedValueOnce(new Error("no window"));
    applyTheme("test.glass");
    await Promise.resolve();
    await Promise.resolve();
    expect(document.documentElement.classList.contains("sl-material")).toBe(false);
  });
});

describe("the root surface", () => {
  it("is painted by <html> alone, so a translucent surface isn't stacked", () => {
    const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");
    const shared = css.match(/^html,\s*body,\s*#root\s*\{([^}]*)\}/m)?.[1] ?? "";
    expect(shared).not.toBe("");
    expect(shared).not.toMatch(/background/);
    expect(css).toMatch(/^html\.sl-material\s*\{\s*background:\s*transparent;/m);
  });
});

describe("a glass theme's colours", () => {
  const rootStyle = () => document.documentElement.style;
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  beforeEach(() => {
    registerTheme(OWNER, {
      id: "test.frosted",
      name: "Frosted",
      vars: { "--color-surface-0": "rgb(10 10 10 / 0.5)", "--font-test": "serif" },
      window: { material: "mica" },
    });
  });

  afterEach(() => {
    rootStyle().removeProperty("--color-surface-0");
    rootStyle().removeProperty("--font-test");
  });

  it("are opaque until the window confirms the material, and other vars are untouched", () => {
    applyTheme("test.frosted");
    expect(rootStyle().getPropertyValue("--color-surface-0")).toBe(
      "rgb(from rgb(10 10 10 / 0.5) r g b / 1)",
    );
    expect(rootStyle().getPropertyValue("--font-test")).toBe("serif");
  });

  it("are applied as given once the material is confirmed", async () => {
    applyTheme("test.frosted");
    await settle();
    expect(document.documentElement.classList.contains("sl-material")).toBe(true);
    expect(rootStyle().getPropertyValue("--color-surface-0")).toBe("rgb(10 10 10 / 0.5)");
  });

  it("stay opaque when the window could not draw the material", async () => {
    setMaterial.mockResolvedValueOnce(false);
    applyTheme("test.frosted");
    await settle();
    expect(rootStyle().getPropertyValue("--color-surface-0")).toBe(
      "rgb(from rgb(10 10 10 / 0.5) r g b / 1)",
    );
  });

  it("turn opaque again when reduced transparency takes the material away", async () => {
    applyTheme("test.frosted");
    await settle();
    document.documentElement.classList.add("sl-opaque");
    syncWindowMaterial();
    expect(rootStyle().getPropertyValue("--color-surface-0")).toBe(
      "rgb(from rgb(10 10 10 / 0.5) r g b / 1)",
    );
  });

  it("are opaque only where they are surfaces: a scrim or tint keeps its alpha", () => {
    registerTheme(OWNER, {
      id: "test.frosted-tint",
      name: "Frosted tint",
      vars: { "--color-surface-1": "rgb(10 10 10 / 0.5)", "--color-accent": "rgb(200 0 0 / 0.3)" },
      window: { material: "acrylic" },
    });
    applyTheme("test.frosted-tint");
    expect(rootStyle().getPropertyValue("--color-surface-1")).toBe("rgb(from rgb(10 10 10 / 0.5) r g b / 1)");
    expect(rootStyle().getPropertyValue("--color-accent")).toBe("rgb(200 0 0 / 0.3)");
    rootStyle().removeProperty("--color-surface-1");
    rootStyle().removeProperty("--color-accent");
  });

  it("leave a theme without a material as it is written, translucent colours included", async () => {
    registerTheme(OWNER, {
      id: "test.plain-colour",
      name: "Plain colour",
      vars: { "--color-surface-0": "rgb(1 2 3 / 0.2)" },
    });
    applyTheme("test.frosted");
    await settle();
    applyTheme("test.plain-colour");
    expect(rootStyle().getPropertyValue("--color-surface-0")).toBe("rgb(1 2 3 / 0.2)");
    rootStyle().removeProperty("--color-surface-0");
  });
});
