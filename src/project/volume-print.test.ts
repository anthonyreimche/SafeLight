// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, it, expect } from "vitest";
import type { NativeFsBridge } from "@/extensions/types";
import { judgeVolume } from "./volume-print";

const SL = "/data/shoot-0123abcd/.safelight";

/** A bridge over `files`, each a path and its contents; reading a path in `failing`
 *  past its first byte fails with EBUSY, as when a virus scanner holds it. */
function bridge(files: Record<string, string>, failing: string[] = []): NativeFsBridge {
  const read = async (path: string, range?: { start: number; end: number }) => {
    const body = files[path];
    if (body === undefined) throw new Error(`ENOENT: ${path}`);
    if (failing.includes(path) && range && range.end > 0)
      throw new Error(`EBUSY: resource busy or locked, open '${path}'`);
    const data = new TextEncoder().encode(body);
    return { data, mtimeMs: 1, size: data.length };
  };
  const list = async (dir: string) => {
    const at = dir.replace(/[/\\]+$/, "");
    const kids = new Map<string, "file" | "directory">();
    for (const path of Object.keys(files)) {
      if (!path.startsWith(`${at}/`)) continue;
      const [name, ...deeper] = path.slice(at.length + 1).split("/");
      kids.set(name, deeper.length > 0 ? "directory" : "file");
    }
    return [...kids].map(([name, kind]) => ({ name, kind }));
  };
  return { read, list } as unknown as NativeFsBridge;
}

const catalogOf = (photos: { relPath: string; fileSize: number; shot?: string }[]) => ({
  [`${SL}/catalog.json`]: JSON.stringify({
    version: 1,
    photos: photos.map(({ relPath, fileSize, shot }) => ({
      id: relPath,
      relPath,
      fileSize,
      ...(shot ? { exif: { dateTimeOriginal: shot } } : {}),
    })),
    edits: [],
  }),
});

describe("judgeVolume", () => {
  const shot = [
    { relPath: "a.NEF", fileSize: 3 },
    { relPath: "b.NEF", fileSize: 3 },
  ];

  it("gives no sign either way for an ordinary folder whose photos were moved into subfolders", async () => {
    const fs = bridge({ ...catalogOf(shot), "D:\\Shoot/Day1/a.NEF": "aaa", "D:\\Shoot/Day2/b.NEF": "bbb" });

    expect(await judgeVolume(fs, "D:\\Shoot", SL)).toBe("unknown");
  });

  it.each(["E:\\", "/Volumes/EOS_DIGITAL", "/media/anna/EOS_DIGITAL", "/run/media/anna/EOS_DIGITAL", "/mnt/card"])(
    "takes a catalog none of whose photos is on the card at %s for another card's",
    async (root) => {
      const at = root.replace(/[/\\]+$/, "");
      const fs = bridge({ ...catalogOf(shot), [`${at}/Day1/a.NEF`]: "aaa" });

      expect(await judgeVolume(fs, root, SL)).toBe("other");
    },
  );

  it("still takes other photos under the catalog's names for another card's in an ordinary folder", async () => {
    const dated = shot.map((p) => ({ ...p, shot: "2024:05:01 10:00:00" }));
    const fs = bridge({ ...catalogOf(dated), "D:\\Shoot/a.NEF": "other a", "D:\\Shoot/b.NEF": "other b" });

    expect(await judgeVolume(fs, "D:\\Shoot", SL)).toBe("other");
  });

  it("gives no sign for photos of another size with no capture time to compare in an ordinary folder", async () => {
    const pngs = [
      { relPath: "a.png", fileSize: 3 },
      { relPath: "b.png", fileSize: 3 },
    ];
    const fs = bridge({ ...catalogOf(pngs), "D:\\Shoot/a.png": "re-exported a", "D:\\Shoot/b.png": "re-exported b" });

    expect(await judgeVolume(fs, "D:\\Shoot", SL)).toBe("unknown");
  });

  it("takes photos of another size with no capture time to compare at a card's root for another card's", async () => {
    const fs = bridge({ ...catalogOf(shot), "E:/a.NEF": "other a", "E:/b.NEF": "other b" });

    expect(await judgeVolume(fs, "E:\\", SL)).toBe("other");
  });

  it("lists a bare drive at its root, not at the drive's current folder", async () => {
    const fs = bridge({ ...catalogOf(shot), "E:/DCIM/c.NEF": "ccc" });
    const listed: string[] = [];
    const list = fs.list.bind(fs);
    fs.list = async (dir) => {
      listed.push(dir);
      return list(dir);
    };

    expect(await judgeVolume(fs, "E:\\", SL)).toBe("other");
    expect(listed).not.toContain("E:");
    expect(listed).toContain("E:\\");
  });

  it("counts a photo of another size whose capture time can't be read right now as no sign", async () => {
    const dated = shot.map((p) => ({ ...p, shot: "2024:05:01 10:00:00" }));
    const files = { "/Volumes/EOS_DIGITAL/a.NEF": "longer a", "/Volumes/EOS_DIGITAL/b.NEF": "longer b" };
    const fs = bridge({ ...catalogOf(dated), ...files }, Object.keys(files));

    expect(await judgeVolume(fs, "/Volumes/EOS_DIGITAL", SL)).toBe("unknown");
  });
});
