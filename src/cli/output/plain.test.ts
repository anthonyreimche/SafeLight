// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The plain paths are a contract with scripts: --json, pipes and anything that
// isn't a terminal get the bytes they always got. These tests hold them still
// while the look on a terminal changes.

import { describe, expect, it } from "vitest";
import { CONTRAST, EXPOSURE, TEMPERATURE, sink } from "./fixtures";
import { createOutput, formatHome, formatPrompt, formatReplNote, resolveOutputOptions } from "./index";
import type { HomeStatus, Output, OutputOptions, ToolRow } from "./index";

const TOOLS: ToolRow[] = [
  { tool: "White Balance", state: "in use", values: [{ info: TEMPERATURE, value: 5600, changed: true, note: "(as shot 5150)" }] },
  { tool: "Basic", state: "in use", values: [{ info: EXPOSURE, value: 0.7, changed: true }, { info: CONTRAST, value: 0, changed: false }] },
];
const HOME: HomeStatus = {
  version: "3.3.0",
  cwd: String.raw`D:\Photos\Iceland 2026`,
  project: { root: String.raw`D:\Photos\Iceland 2026`, name: "Iceland 2026", photos: 412, edited: 38, picks: 12 },
  guiHasProjectOpen: false,
  graphics: "d3d11",
  settingsShared: true,
  extensions: { installed: 14, updates: 2 },
};

/** Everything a command can print, through one Output, as the bytes each stream received. */
function everything(options: OutputOptions, tty: { stdout: boolean; stderr: boolean }): { stdout: string; stderr: string; built: string[] } {
  const stdout = sink(tty.stdout, options.width);
  const stderr = sink(tty.stderr, options.width);
  const out: Output = createOutput({ stdout: stdout.stream, stderr: stderr.stream }, options);
  const built = [
    out.formatValue(EXPOSURE, -0.7),
    out.formatRange(EXPOSURE),
    out.photoHeader({ name: "DSC_0412.NEF", camera: "Nikon Z 6II", megapixels: 24, edited: true, processVersion: 2, step: { at: 4, of: 6 }, rating: 4, flag: "pick", label: "blue" }),
    out.toolTable(TOOLS),
    out.toolTable(TOOLS, { all: true, picture: ["▀▀"] }),
    out.photoTable([{ name: "DSC_0398.NEF", rating: 5, flag: "pick", label: "red", edited: true, size: "24 MP" }]),
    out.extensionTable([{ name: "Basic", id: "safelight.basic", version: "1.4.0", enabled: true, trust: "official", update: "1.5.0", description: "The basics." }]),
    out.searchTable([{ installName: "local-contrast", name: "Local Contrast", version: "1.0.0", category: "tone", trust: "verified", description: "Lifts fine detail." }]),
    out.historyList([{ index: 1, label: "Opened", timestamp: 0, current: false }, { index: 2, label: "Exposure", timestamp: 0, current: true }], "DSC_0412.NEF"),
    out.resultLine({ photo: "DSC_0412.NEF", step: 5, changes: [{ label: "Exposure", value: "+0.70 EV", info: EXPOSURE, before: 0.5, after: 0.7 }] }),
    out.summary({ photos: 78, stepEach: true, failed: 2, skipped: 1 }),
    out.exported({ path: String.raw`D:\out\DSC_0398.jpg`, width: 2048, height: 1365, colourSpace: "sRGB", bytes: 1_468_006 }),
    out.help({ version: "3.3.0", verbs: [{ verb: "photos", group: "Look", summary: "" }, { verb: "help", group: "More", summary: "" }] }),
    out.verbHelp({ verb: "tools", usage: "tools [photo] [--all]", summary: "Lists the tools.", options: [{ flag: "--all", summary: "Also list idle tools." }], examples: ["safelight tools a.ARW"] }),
    out.doctor([{ label: "App", value: "Safelight 3.3.0", status: "ok", hint: "Nothing to do." }, { label: "Extensions", value: "Retinex failed", status: "fail" }]),
    out.previewCaption({ mode: "sixel", trueColour: true, width: 80, height: 24, ms: 420 }),
    out.problem("error", { message: "No photo matches.", hint: "safelight photos lists them.", fix: "photos" }),
    out.progressText({ label: "Exporting", done: 3, total: 10, items: [{ name: "a", state: "working" }], startedAt: 0 }),
    formatHome(HOME, options),
    formatPrompt({ projectName: "Iceland 2026" }, options),
    out.listing({
      summary: { title: "Iceland 2026", photos: 2, edited: 1, notImported: 1 },
      folders: [{ name: "Drone", photos: 22, edited: 0, notImported: 22 }],
      photos: [
        { name: "DSC_0398.NEF", rating: 5, flag: "pick", label: "red", edited: true, state: "imported" },
        { name: "DSC_0500.NEF", rating: 0, flag: "none", label: "", edited: false, state: "new" },
      ],
      fix: { command: "import .", does: "imports the new photo." },
    }),
    out.folderTree({ name: "Iceland 2026", path: ".", photos: 2, edited: 1, notImported: 1, children: [] }, { title: "Iceland 2026", photos: 2, edited: 1, notImported: 1 }),
    out.keywordTable([{ keyword: "iceland", count: 2 }]),
    out.keywordList([{ photo: "DSC_0398.NEF", keywords: ["iceland"] }]),
    out.exportSummary({ exported: 77, failed: [{ name: "a.NEF", error: "can't be decoded" }], folder: "out", bytes: 1, ms: 1 }),
    out.importPlan({ project: "Iceland 2026", newFiles: 2, gone: 1 }),
    out.importedFile({ path: "DSC_0500.NEF", state: "ok" }),
    out.importSummary({ project: "Iceland 2026", imported: 1, total: 2, ms: 1200, failed: ["b.NEF"], moved: [{ from: "a", to: "b" }], dropped: [{ relPath: "c" }], pending: 1, stopped: null }),
    out.problem("error", out.forgetProblem({ photos: 2, edited: ["a.NEF"], command: "forget . --yes" })),
    formatPrompt({ projectName: "Iceland 2026", folder: "Day 2", open: { name: "DSC_0412", at: 2, of: 3 }, readOnly: true }, options),
    formatReplNote("unknown", options, "sett"),
  ];
  for (const text of built.slice(2, 16)) out.print(text);
  out.json({ slu: 1, photos: [{ relPath: "DSC_0412.NEF", exposure: 0.7 }] });
  out.warn({ message: "exposure 7 is past its limit, so it was set to 5 EV." });
  out.error({ message: "No photo matches.", hint: "safelight photos lists them.", fix: "photos" });
  out.info("safelight tools --all lists idle tools too.");
  out.progress({ label: "Exporting", done: 1, total: 3, items: [{ name: "a", state: "working" }], startedAt: 0 });
  out.progress(null);
  out.result({ photo: "DSC_0412.NEF", step: 5, changes: [{ label: "Exposure", value: "+0.70 EV", info: EXPOSURE, before: 0.5, after: 0.7 }] });
  out.writeRaw(new TextEncoder().encode("raw"));
  return { stdout: stdout.text(), stderr: stderr.text(), built };
}

/** The options as they were before terminals got a look of their own. */
const before = (options: OutputOptions): OutputOptions => ({ ...options, caps: undefined });

const PIPED = { stdout: false, stderr: false };
const env = { LANG: "en_CA.UTF-8", COLORTERM: "truecolor" };
const resolve = (tty: { stdout: boolean; stderr: boolean }, more: Record<string, string> = {}, verbosity: OutputOptions["verbosity"] = "verbose") =>
  resolveOutputOptions({ stdout: sink(tty.stdout, 100).stream, stderr: sink(tty.stderr, 100).stream }, { ...env, ...more }, verbosity);

describe("the plain paths", () => {
  it("writes no escape code when neither stream is a terminal", () => {
    const run = everything(resolve(PIPED), PIPED);
    expect(run.stdout + run.stderr + run.built.join("")).not.toContain("\x1b");
  });

  it("gives a pipe the bytes it always got, builder by builder and stream by stream", () => {
    for (const verbosity of ["normal", "verbose", "quiet"] as const) {
      const options = resolve(PIPED, {}, verbosity);
      expect(options.caps?.rich).toEqual(PIPED);
      expect(everything(options, PIPED)).toEqual(everything(before(options), PIPED));
    }
  });

  it("holds for FORCE_COLOR on a pipe, NO_COLOR, and a terminal that says it is dumb", () => {
    for (const [tty, more] of [[PIPED, { FORCE_COLOR: "1" }], [PIPED, { NO_COLOR: "1" }], [{ stdout: true, stderr: true }, { TERM: "dumb" }]] as const) {
      const options = resolve(tty, more);
      expect(everything(options, tty)).toEqual(everything(before(options), tty));
    }
    expect(everything(resolve(PIPED, { FORCE_COLOR: "1" }), PIPED).stdout).toContain("\x1b[1mDSC_0412.NEF\x1b[22m");
  });

  it("judges each stream alone: a piped stdout is untouched while stderr is a terminal, and the other way round", () => {
    const stdoutPiped = { stdout: false, stderr: true };
    const options = resolve(stdoutPiped, { NO_COLOR: "1" });
    expect(everything(options, stdoutPiped).stdout).toBe(everything(before(options), stdoutPiped).stdout);
    expect(everything(resolve(stdoutPiped), stdoutPiped).stdout).toBe(everything(before(resolve(PIPED)), PIPED).stdout);

    const stderrPiped = { stdout: true, stderr: false };
    expect(everything(resolve(stderrPiped), stderrPiped).stderr).toBe(everything(before(resolve(PIPED)), PIPED).stderr);
  });

  it("keeps these exact bytes", () => {
    const run = everything(resolve(PIPED, {}, "normal"), PIPED);
    expect(run.built[2]).toBe("DSC_0412.NEF · Nikon Z 6II · 24 MP · edited · process version 2");
    expect(run.built[3]).toBe([
      "White Balance  temperature   5600 K  ✱  2000…50000  (as shot 5150)",
      "Basic          exposure     +0.70 EV ✱  −5…5",
      "               contrast         0       −100…100",
    ].join("\n"));
    expect(run.built[4]).toBe(run.built[3]);
    expect(run.built[9]).toBe("DSC_0412.NEF  Exposure +0.70 EV   (step 5)");
    expect(run.built[10]).toBe("78 photos · 1 step each · 2 failed · 1 skipped");
    expect(run.built[11]).toBe(String.raw`D:\out\DSC_0398.jpg  2048×1365 · sRGB · 1.4 MB`);
    expect(run.built[15]).toBe("sixel · 24-bit · 0.4 s");
    expect(run.built[16]).toBe("safelight: No photo matches.\n           safelight photos lists them.");
    expect(run.stderr).toBe([
      "safelight: exposure 7 is past its limit, so it was set to 5 EV.",
      "safelight: No photo matches.",
      "           safelight photos lists them.",
      "",
    ].join("\n"));
    expect(run.stdout.endsWith("DSC_0412.NEF  Exposure +0.70 EV   (step 5)\nraw")).toBe(true);
  });

  it("prints one JSON document with no colour and no margin, even on a terminal", () => {
    const tty = { stdout: true, stderr: true };
    const stdout = sink(true, 100);
    const out = createOutput({ stdout: stdout.stream, stderr: sink(true, 100).stream }, resolve(tty));
    out.json({ slu: 1, photos: [{ relPath: "DSC_0412.NEF" }] });
    expect(stdout.text()).toBe('{\n  "slu": 1,\n  "photos": [\n    {\n      "relPath": "DSC_0412.NEF"\n    }\n  ]\n}\n');
  });

  it("never wraps raw bytes in anything", () => {
    const stdout = sink(true, 100);
    const out = createOutput({ stdout: stdout.stream, stderr: sink(true, 100).stream }, resolve({ stdout: true, stderr: true }));
    out.writeRaw(new Uint8Array([0x1b, 0x50, 0x71]));
    expect(stdout.chunks).toHaveLength(1);
    expect([...Buffer.from(stdout.chunks[0], "latin1")]).toEqual([0x1b, 0x50, 0x71]);
  });

  it("marks a terminal rich, which is the only thing that turns the designed look on", () => {
    const options = resolve({ stdout: true, stderr: true });
    expect(options.caps).toMatchObject({ tier: "truecolour", glyphs: "full", motion: "full", rich: { stdout: true, stderr: true } });
    const stdout = sink(true, 100);
    createOutput({ stdout: stdout.stream, stderr: sink(true, 100).stream }, options).print("No extensions are installed.");
    expect(stdout.text()).toBe("  No extensions are installed.\n");
  });
});
