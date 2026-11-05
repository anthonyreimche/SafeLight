// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Linux packaging config. Setting build.deb.depends or build.flatpak.finishArgs
// replaces electron-builder's defaults instead of adding to them, so the
// defaults are restated here and must stay covered.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import types from "./photo-types.json";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(`${ROOT}package.json`, "utf8")) as {
  build: {
    deb: { depends: string[]; executableArgs: string[] };
    rpm: { executableArgs: string[] };
    pacman: { executableArgs: string[] };
    flatpak: { finishArgs: string[] };
    linux: { mimeTypes: string[] };
  };
};
const flake = readFileSync(`${ROOT}flake.nix`, "utf8");

// app-builder-lib FpmTarget.getDefaultDepends("deb")
const DEB_DEFAULTS = [
  "libgtk-3-0",
  "libnotify4",
  "libnss3",
  "libxss1",
  "libxtst6",
  "xdg-utils",
  "libatspi2.0-0",
  "libuuid1",
  "libsecret-1-0",
];

// app-builder-lib flatpakBuilderDefaults.finishArgs
const FLATPAK_DEFAULTS = [
  "--socket=wayland",
  "--socket=x11",
  "--share=ipc",
  "--device=dri",
  "--socket=pulseaudio",
  "--filesystem=home",
  "--share=network",
  "--talk-name=org.freedesktop.Notifications",
];

describe("deb package", () => {
  it("keeps electron-builder's default dependencies", () => {
    expect(pkg.build.deb.depends).toEqual(expect.arrayContaining(DEB_DEFAULTS));
  });

  it("adds audio and the gio trash helper", () => {
    expect(pkg.build.deb.depends).toEqual(
      expect.arrayContaining(["libasound2 | libasound2t64", "libglib2.0-bin", "xdg-utils"]),
    );
  });
});

describe("flatpak package", () => {
  it("keeps the default sandbox holes and adds removable-media paths", () => {
    expect(pkg.build.flatpak.finishArgs).toEqual(
      expect.arrayContaining([
        ...FLATPAK_DEFAULTS,
        "--filesystem=/media",
        "--filesystem=/run/media",
        "--filesystem=/mnt",
      ]),
    );
  });
});

describe("desktop entry", () => {
  it.each(["deb", "rpm", "pacman"] as const)("%s opens every selected file (%%F)", (target) => {
    expect(pkg.build[target].executableArgs).toEqual(["%F"]);
  });

  it("flake.nix opens every selected file (%F)", () => {
    expect(flake).toMatch(/exec = "safelight %F";/);
  });

  it("flake.nix mime types are ones the app declares", () => {
    const block = /mimeTypes = \[([^\]]*)\]/.exec(flake)?.[1] ?? "";
    const listed = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const known = new Set(
      [...Object.values(types.standard), ...Object.values(types.raw)].filter(
        (m): m is string => m !== null,
      ),
    );
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.filter((m) => !known.has(m) || !pkg.build.linux.mimeTypes.includes(m))).toEqual([]);
  });
});
