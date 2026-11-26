// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Memory cards: mounted volumes holding a DCIM folder, found without a native
// module or a shell. Every check goes through the libuv pool, which a stalled
// drive can hold, so checks run one at a time and a volume that stalls is left
// alone for a while.

import { describe, expect, it, vi } from "vitest";
import { createCardScanner } from "./memory-cards.cjs";

interface Dcim {
  birthtimeMs: number;
  ino: number;
}

function rig(opts: {
  platform: NodeJS.Platform;
  dcim?: Record<string, Dcim | "hang">;
  dirs?: Record<string, string[]>;
  links?: Record<string, string>;
}) {
  let clock = 0;
  let running = 0;
  let mostAtOnce = 0;
  const probed: string[] = [];
  const probe = vi.fn(async (dir: string) => {
    probed.push(dir);
    running++;
    mostAtOnce = Math.max(mostAtOnce, running);
    try {
      const found = opts.dcim?.[dir];
      if (found === "hang") return new Promise<never>(() => {});
      await Promise.resolve();
      return found ?? null;
    } finally {
      running--;
    }
  });
  const scanner = createCardScanner({
    platform: opts.platform,
    probe,
    readdir: async (dir: string) => {
      const names = opts.dirs?.[dir];
      if (!names) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return names;
    },
    realpath: async (p: string) => opts.links?.[p] ?? p,
    systemDrive: "C:",
    username: "ana",
    now: () => clock,
    timeoutMs: 20,
  });
  return {
    scanner,
    probed,
    probe,
    mostAtOnce: () => mostAtOnce,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const card = (birthtimeMs: number, ino = 1): Dcim => ({ birthtimeMs, ino });

describe("createCardScanner on Windows", () => {
  it("finds drive letters holding DCIM, never the system drive", async () => {
    const { scanner, probed } = rig({ platform: "win32", dcim: { "E:\\DCIM": card(5), "G:\\DCIM": card(6) } });
    const cards = await scanner.list();
    expect(cards.map((c) => [c.name, c.path])).toEqual([
      ["E:", "E:\\"],
      ["G:", "G:\\"],
    ]);
    expect(probed).not.toContain("C:\\DCIM");
    expect(probed).toContain("Z:\\DCIM");
  });

  it("checks one drive at a time", async () => {
    const { scanner, mostAtOnce } = rig({ platform: "win32", dcim: { "E:\\DCIM": card(5) } });
    await scanner.list();
    expect(mostAtOnce()).toBe(1);
  });

  it("skips a drive that stalls, and leaves it alone for a minute", async () => {
    const r = rig({ platform: "win32", dcim: { "F:\\DCIM": "hang", "H:\\DCIM": card(7) } });
    expect((await r.scanner.list()).map((c) => c.name)).toEqual(["H:"]);
    r.advance(30_000);
    r.probed.length = 0;
    await r.scanner.list();
    expect(r.probed).not.toContain("F:\\DCIM");
    r.advance(31_000);
    r.probed.length = 0;
    await r.scanner.list();
    expect(r.probed).toContain("F:\\DCIM");
  });
});

describe("createCardScanner on macOS and Linux", () => {
  it("finds volumes holding DCIM, leaving out the boot volume", async () => {
    const { scanner, probed } = rig({
      platform: "darwin",
      dirs: { "/Volumes": ["Macintosh HD", "EOS_DIGITAL", "Backup"] },
      links: { "/Volumes/Macintosh HD": "/" },
      dcim: { "/Volumes/EOS_DIGITAL/DCIM": card(1) },
    });
    expect(await scanner.list()).toEqual([
      { id: expect.any(String), name: "EOS_DIGITAL", path: "/Volumes/EOS_DIGITAL" },
    ]);
    expect(probed).not.toContain("/Volumes/Macintosh HD/DCIM");
  });

  it("looks under the user's media folders on Linux", async () => {
    const { scanner } = rig({
      platform: "linux",
      dirs: { "/media/ana": ["NIKON Z 8"], "/run/media/ana": ["SD"], "/media": ["ana", "cdrom"] },
      dcim: {
        "/media/ana/NIKON Z 8/DCIM": card(1),
        "/run/media/ana/SD/DCIM": card(2),
        "/media/cdrom/DCIM": card(3),
      },
    });
    expect((await scanner.list()).map((c) => c.path)).toEqual([
      "/media/ana/NIKON Z 8",
      "/run/media/ana/SD",
      "/media/cdrom",
    ]);
  });

  it("finds nothing elsewhere", async () => {
    expect(await rig({ platform: "aix" }).scanner.list()).toEqual([]);
  });
});

describe("createCardScanner identity and caching", () => {
  it("gives a different card in the same slot a new id", async () => {
    const dcim: Record<string, Dcim> = { "E:\\DCIM": card(100) };
    const r = rig({ platform: "win32", dcim });
    const [first] = await r.scanner.list();
    r.advance(5_000);
    expect((await r.scanner.list())[0].id).toBe(first.id);
    dcim["E:\\DCIM"] = card(200);
    r.advance(5_000);
    expect((await r.scanner.list())[0].id).not.toBe(first.id);
  });

  it("answers from its last scan for two seconds, and shares a scan in flight", async () => {
    const r = rig({ platform: "win32", dcim: { "E:\\DCIM": card(1) } });
    await Promise.all([r.scanner.list(), r.scanner.list()]);
    const probes = r.probe.mock.calls.length;
    r.advance(1_000);
    await r.scanner.list();
    expect(r.probe.mock.calls.length).toBe(probes);
    r.advance(1_500);
    await r.scanner.list();
    expect(r.probe.mock.calls.length).toBe(probes * 2);
  });
});
