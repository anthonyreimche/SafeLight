// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "@/catalog/types";
import { BUILTIN_EXTENSIONS } from "@/extensions/builtin";
import { useDisabledExtensions } from "@/extensions/loader";
import { nativeDirectoryHandle } from "@/project/native-fs";
import { useProjectStore } from "@/project/project-store";
import { useCatalogStore } from "@/state/catalog-store";
import { clearErrorLog, recordError } from "./error-log";
import { collectReportSections } from "./collect";
import type { ReportSection } from "./report-markdown";

const native = {
  platform: "win32",
  versions: { electron: "42.4.0", chrome: "142.0.1" },
  system: { arch: "x64", osVersion: "10.0.26300" },
  appVersion: () => Promise.resolve("3.0.1"),
  plugins: {
    list: () =>
      Promise.resolve([{ id: "acme.film", name: "Film", version: "1.2.0", main: "dist/index.js" }]),
  },
  diagnostics: {
    gpuInfo: () => Promise.resolve({ gpu_compositing: "enabled" }),
    metrics: () => Promise.resolve([]),
    crashes: () => Promise.resolve([{ time: 5, process: "GPU", reason: "crashed", exitCode: 1 }]),
  },
  claimPrivileged: () => ({ fs: {}, updates: {} }),
};

const photo: CatalogPhoto = {
  id: "p1",
  filename: "SECRET_NAME_123.NEF",
  relPath: "SecretTrip/SECRET_NAME_123.NEF",
  folder: "SecretTrip",
  directoryHandle: null,
  fileHandle: null,
  thumbnailBlob: null,
  thumbnailUrl: null,
  width: 6048,
  height: 4024,
  fileSize: 1,
  mimeType: "image/x-nikon-nef",
  rating: 0,
  colorLabel: "none",
  flag: "none",
  rotation: 0,
  keywords: [],
  dateCreated: 0,
  dateImported: 0,
  exif: { cameraModel: "NIKON Z 6", bodySerial: "SERIAL-BODY-9", gpsLatitude: 51.123456 },
};

const textOf = (sections: ReportSection[], id: ReportSection["id"]): string =>
  sections.find((s) => s.id === id)?.text ?? "";

const defaultDisabled = BUILTIN_EXTENSIONS.filter((b) => b.disabledByDefault).map((b) => b.id);

beforeEach(() => {
  vi.stubGlobal("safelightNative", native);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  clearErrorLog();
  localStorage.clear();
  useDisabledExtensions.setState({ ids: defaultDisabled });
  useCatalogStore.setState({ photos: [], activePhotoId: null });
  useProjectStore.setState({ root: null, name: "" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("collectReportSections", () => {
  it("lists the sections in order, with a crash first when there is one", async () => {
    const sections = await collectReportSections({ crash: { what: "Panel", message: "boom" } });
    expect(sections.map((s) => s.id)).toEqual(["crash", "environment", "graphics", "extensions", "context", "errors"]);
    expect(sections.every((s) => s.include)).toBe(true);
    const plain = await collectReportSections(null);
    expect(plain.map((s) => s.id)).toEqual(["environment", "graphics", "extensions", "context", "errors"]);
  });

  it("redacts the project folder and home folders in every section", async () => {
    useProjectStore.setState({ root: nativeDirectoryHandle("C:\\Users\\ann\\Shoot"), name: "Shoot" });
    recordError("error", "skipped C:\\Users\\ann\\Shoot\\day1\\notes.txt near C:\\Users\\ann\\AppData\\x.js");
    const sections = await collectReportSections({
      crash: { what: "Panel", message: "can't read C:\\Users\\ann\\Shoot\\a\\b.txt" },
    });
    expect(textOf(sections, "errors")).toContain("skipped <folder>/…/notes.txt near ~/…/x.js");
    expect(textOf(sections, "crash")).toContain("can't read <folder>/…/b.txt");
    expect(sections.map((s) => s.text).join("\n")).not.toContain("ann");
  });

  it("hides the catalog's own folders, and the folders above them, in relative paths", async () => {
    useCatalogStore.setState({ photos: [{ ...photo, folder: "Smith Wedding/day1/selects" }], activePhotoId: null });
    recordError("error", "[folder-ops] move Smith Wedding/day1/notes.txt failed");
    const text = textOf(await collectReportSections(null), "errors");
    expect(text).toContain("[folder-ops] move …/notes.txt failed");
  });

  it("describes the open photo without its name, location or serial numbers", async () => {
    useCatalogStore.setState({ photos: [photo], activePhotoId: "p1" });
    const sections = await collectReportSections(null);
    const all = sections.map((s) => `${s.summary}\n${s.text}`).join("\n");
    expect(textOf(sections, "context")).toContain("Camera: NIKON Z 6");
    for (const secret of ["SECRET_NAME", "SecretTrip", "SERIAL", "51.12"]) expect(all).not.toContain(secret);
  });

  it("lists installed extensions and built-ins switched from their default", async () => {
    useDisabledExtensions.setState({ ids: defaultDisabled.filter((id) => id !== "core.devtools") });
    const text = textOf(await collectReportSections(null), "extensions");
    expect(text).toContain("- acme.film 1.2.0 · on, not running · unverified");
    expect(text.split("Built-in changes:\n")[1]?.split("\n")[0]).toBe("- core.devtools · on (off by default)");
  });

  it("leaves built-ins at their defaults out", async () => {
    expect(textOf(await collectReportSections(null), "extensions")).not.toContain("Built-in changes:");
  });

  it("includes saved errors and main-process crashes", async () => {
    recordError("warn", "[libraw] decode failed");
    const text = textOf(await collectReportSections(null), "errors");
    expect(text).toContain("[libraw] decode failed");
    expect(text).toContain("GPU process gone: crashed (exit 1)");
  });

  it("works without the Electron bridge", async () => {
    vi.unstubAllGlobals();
    const sections = await collectReportSections(null);
    expect(textOf(sections, "environment")).toContain("(browser build)");
    expect(textOf(sections, "extensions")).toBe("No extensions installed; built-ins at their defaults.");
  });
});
