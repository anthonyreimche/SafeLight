import { describe, expect, it, vi } from "vitest";
import { freshParams, type CatalogPhoto, type EditState } from "@/catalog/types";
import { parseArgs } from "../args";
import type { CommandContext, ProjectRef, ReadSession } from "../types";
import { previewCommand } from "./preview";

const PROJECT: ProjectRef = { root: "/p", workingDir: "/p/.safelight", location: "in-folder" };

const photo = (over: Partial<CatalogPhoto> = {}): CatalogPhoto =>
  ({ id: "a", relPath: "a.ARW", rating: 0, colorLabel: "none", flag: "none", exif: { colorTemperature: 5200 }, ...over }) as CatalogPhoto;

const state = (exposures: number[], currentIndex = exposures.length - 1): EditState => ({
  photoId: "a",
  currentIndex,
  stack: exposures.map((exposure, i) => ({ timestamp: i, label: i === 0 ? "Original" : `Step ${i + 1}`, params: { ...freshParams(5200), exposure }, paramBag: {} })),
});

function harness(edit: EditState | undefined, p: CatalogPhoto = photo()) {
  const show = vi.fn(async () => undefined);
  const printed: string[] = [];
  const requested: unknown[] = [];
  const session = { project: PROJECT, photos: () => [p], edit: async () => edit, previewFile: () => null, close: async () => undefined } as unknown as ReadSession;
  const ctx = {
    json: false,
    readStdin: async () => "",
    out: { print: (t: string) => printed.push(t), warn: () => undefined },
    engine: () => ({ shutdown: async () => undefined }),
    preview: { show },
    select: {
      read: async (req: unknown) => {
        requested.push(req);
        return { groups: [{ session, photos: [p] }], missing: [], close: async () => undefined };
      },
    },
  } as unknown as CommandContext;
  return { ctx, show, printed, requested };
}

const run = (ctx: CommandContext, argv: string[]) => previewCommand.run(ctx, parseArgs(["preview", ...argv], previewCommand));
const shown = (show: ReturnType<typeof vi.fn>) => (show.mock.calls[0] as unknown[])[2] as { overrides?: { params?: { exposure?: number } } };

describe("preview --before and --step", () => {
  it("renders the first step's look for --before and says which step", async () => {
    const h = harness(state([0, 0.5, 1.5]));
    expect((await run(h.ctx, ["a.ARW", "--before"])).code).toBe(0);
    expect(shown(h.show).overrides?.params?.exposure).toBe(0);
    expect(h.printed.at(-1)).toContain("before · step 1 of 3");
  });

  it("renders any step, counted from 1", async () => {
    const h = harness(state([0, 0.5, 1.5]));
    await run(h.ctx, ["a.ARW", "--step", "2"]);
    expect(shown(h.show).overrides?.params?.exposure).toBe(0.5);
    expect(h.printed.at(-1)).toContain("step 2 of 3");
    expect(h.printed.at(-1)).not.toContain("before");
  });

  it("shows the step even when the cursor is on an earlier one", async () => {
    const h = harness(state([0, 0.5, 1.5], 0));
    await run(h.ctx, ["a.ARW", "--step", "3"]);
    expect(shown(h.show).overrides?.params?.exposure).toBe(1.5);
  });

  it("uses the look a never-edited photo opens on", async () => {
    const h = harness(undefined, photo({ exif: { colorTemperature: 4300 } }));
    await run(h.ctx, ["a.ARW", "--before"]);
    expect(shown(h.show).overrides?.params).toEqual(freshParams(4300));
    expect(h.printed.at(-1)).toContain("step 1 of 1");
  });

  it("sends no look of its own without either option", async () => {
    const h = harness(state([0, 0.5]));
    await run(h.ctx, ["a.ARW"]);
    expect(shown(h.show).overrides).toBeUndefined();
    expect(h.printed).toEqual([]);
  });

  it("refuses a step the photo doesn't have, and the two options together", async () => {
    const h = harness(state([0, 0.5]));
    await expect(run(h.ctx, ["a.ARW", "--step", "3"])).rejects.toMatchObject({ code: 1, message: expect.stringContaining("2 steps") });
    await expect(run(h.ctx, ["a.ARW", "--step", "0"])).rejects.toMatchObject({ code: 1 });
    await expect(run(h.ctx, ["a.ARW", "--before", "--step", "2"])).rejects.toMatchObject({ code: 1 });
    await expect(run(h.ctx, ["a.ARW", "--before", "--try", "exposure=1"])).rejects.toMatchObject({ code: 1 });
    expect(h.show).not.toHaveBeenCalled();
  });

  it("previews the current open photo when none is named", async () => {
    const h = harness(state([0, 0.5]));
    (h.ctx as { working?: unknown }).working = { paths: ["/p/a.ARW", "/p/b.ARW"], index: 0, root: "/p" };
    await run(h.ctx, ["--before"]);
    expect(h.requested[0]).toMatchObject({ specs: ["/p/a.ARW"] });
  });
});
