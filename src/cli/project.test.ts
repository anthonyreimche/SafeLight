import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeFsBridge } from "./node-fs";
import { createProjectService } from "./project";
import type { CliEnv } from "./types";

let base: string;
let userData: string;
let service: ReturnType<typeof createProjectService>;

function env(): CliEnv {
  return {
    cwd: base, userData, appRoot: base, appVersion: "0", platform: process.platform,
    isTTY: { stdin: false, stdout: false, stderr: false }, env: {},
  };
}

function catalogue(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "catalog.json"), "{}");
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "slu-project-"));
  userData = join(base, "userData");
  mkdirSync(userData);
  service = createProjectService(env(), createNodeFsBridge(userData));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("find", () => {
  it("finds the catalogue above a photo's folder", async () => {
    const shoot = join(base, "shoot");
    catalogue(join(shoot, ".safelight"));
    mkdirSync(join(shoot, "day1"));
    writeFileSync(join(shoot, "day1", "a.ARW"), "x");
    expect(await service.find(join(shoot, "day1", "a.ARW"))).toEqual({
      root: shoot, workingDir: join(shoot, ".safelight"), location: "in-folder",
    });
  });

  it("prefers the nearest of nested projects", async () => {
    const outer = join(base, "outer");
    const inner = join(outer, "inner");
    catalogue(join(outer, ".safelight"));
    catalogue(join(inner, ".safelight"));
    expect((await service.find(join(inner, "a.ARW")))?.root).toBe(inner);
    expect((await service.find(outer))?.root).toBe(outer);
  });

  it("follows a spillover pointer to the separate catalogue", async () => {
    const shoot = join(base, "card");
    mkdirSync(shoot);
    const external = join(userData, "external-catalogs", "card-abc");
    catalogue(external);
    const tag = createHash("sha1").update(resolve(shoot)).digest("hex");
    const pointers = join(userData, "external-catalogs", ".pointers");
    mkdirSync(pointers, { recursive: true });
    writeFileSync(join(pointers, `${tag}.json`), JSON.stringify({ source: resolve(shoot), spillover: external }));
    expect(await service.find(join(shoot, "a.ARW"))).toEqual({ root: shoot, workingDir: external, location: "external" });
  });

  it("finds a separate catalogue by its sha1 name", async () => {
    const shoot = join(base, "party");
    mkdirSync(shoot);
    const tag = createHash("sha1").update(resolve(shoot)).digest("hex").slice(0, 8);
    const external = join(userData, "external-catalogs", `party-${tag}`, ".safelight");
    catalogue(external);
    expect((await service.find(shoot))?.workingDir).toBe(external);
  });

  it("is null when no catalogue holds the path", async () => {
    mkdirSync(join(base, "bare"));
    expect(await service.find(join(base, "bare", "a.ARW"))).toBeNull();
  });
});
