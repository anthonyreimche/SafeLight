// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogueStamp } from "../preview-cache";
import { watchCatalogue, type Watch } from "./sync";

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "slu-live-"));
  dirs.push(dir);
  return dir;
}

function until(check: () => boolean, ms = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (check()) resolve();
      else if (Date.now() - started > ms) reject(new Error("timed out"));
      else setTimeout(poll, 10);
    };
    poll();
  });
}

describe("watching the catalogue", () => {
  it("tells once, 150 ms after a burst of events on the catalogue file, and not for other files", () => {
    vi.useFakeTimers();
    let emit: (file: string | null) => void = () => {};
    const watch: Watch = (_dir, onEvent) => {
      emit = onEvent;
      return { close: () => {} };
    };
    const changed = vi.fn();
    watchCatalogue("D:\\shoot\\.safelight", changed, { watch });

    emit("previews");
    emit("catalog.json.tmp");
    vi.advanceTimersByTime(100);
    emit("catalog.json");
    vi.advanceTimersByTime(149);
    expect(changed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(changed).toHaveBeenCalledTimes(1);

    emit("previews");
    emit("lock");
    vi.advanceTimersByTime(500);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("sees a real write to catalog.json in a folder, and stops when closed", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "catalog.json"), "{}");
    let changes = 0;
    const stop = watchCatalogue(dir, () => { changes++; }, { debounceMs: 20 });

    await writeFile(path.join(dir, "catalog.json"), '{"a":1}');
    await until(() => changes === 1);
    stop();
    await writeFile(path.join(dir, "catalog.json"), '{"a":2}');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(changes).toBe(1);
  });

  it("stamps the catalogue by its time and size, and has none for a folder without one", async () => {
    const dir = await tempDir();
    expect(await catalogueStamp(dir)).toBeUndefined();
    await writeFile(path.join(dir, "catalog.json"), "{}");
    const first = await catalogueStamp(dir);
    expect(first).toMatch(/^\d+(\.\d+)?:2$/);
    await writeFile(path.join(dir, "catalog.json"), '{"photos":[]}');
    expect(await catalogueStamp(dir)).not.toBe(first);
  });
});
