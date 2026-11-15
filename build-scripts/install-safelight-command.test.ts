import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MARKER, installShims, shimFiles } from "./install-safelight-command.mjs";

let temp = "";
afterEach(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
  temp = "";
});

const REPO = "D:\\Repos\\Safe Light";

describe("install-safelight-command", () => {
  it("builds three shims that run the repo's bundle under node, each carrying the marker", () => {
    const files = shimFiles(REPO);
    expect(Object.keys(files).sort()).toEqual(["safelight", "safelight.cmd", "safelight.ps1"]);
    for (const content of Object.values(files)) expect(content).toContain(MARKER);
    expect(files["safelight.cmd"]).toContain(`node "${REPO}\\dist-cli\\slu.mjs" %*`);
    expect(files["safelight.cmd"]).toContain("\r\n");
    expect(files["safelight.ps1"]).toContain("$args");
    expect(files["safelight.ps1"]).toContain("exit $LASTEXITCODE");
    expect(files.safelight).toContain('exec node "');
    expect(files.safelight).toContain('/dist-cli/slu.mjs" "$@"');
    expect(files.safelight).not.toContain("\r");
  });

  it("writes the shims into the prefix folder", async () => {
    temp = await mkdtemp(join(tmpdir(), "slu-shims-"));
    const result = installShims({ prefix: temp, repo: REPO });
    expect(result.refused).toBeNull();
    expect(result.written).toHaveLength(3);
    expect(await readFile(join(temp, "safelight.cmd"), "utf8")).toBe(shimFiles(REPO)["safelight.cmd"]);
  });

  it("replaces its own shims on a second run", async () => {
    temp = await mkdtemp(join(tmpdir(), "slu-shims-"));
    installShims({ prefix: temp, repo: REPO });
    const result = installShims({ prefix: temp, repo: "D:\\Elsewhere" });
    expect(result.refused).toBeNull();
    expect(await readFile(join(temp, "safelight.ps1"), "utf8")).toContain("D:\\Elsewhere");
  });

  it("refuses, and writes nothing, when a safelight file isn't ours", async () => {
    temp = await mkdtemp(join(tmpdir(), "slu-shims-"));
    await writeFile(join(temp, "safelight.ps1"), "# someone else's\n");
    const result = installShims({ prefix: temp, repo: REPO });
    expect(result.refused).toBe(join(temp, "safelight.ps1"));
    expect(result.written).toEqual([]);
    await expect(readFile(join(temp, "safelight.cmd"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(temp, "safelight.ps1"), "utf8")).toBe("# someone else's\n");
  });
});
