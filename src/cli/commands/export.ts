// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { statSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { EngineEvent, ExportTarget, ExportWireSettings, LookOverride } from "@/engine/protocol";
import { PHOTO_OPTIONS } from "../args";
import {
  engineError,
  isFrame,
  newRequestId,
  projectWire,
  tryOverrides,
} from "../preview";
import { buildSelectRequest, missingError, stdinPathsOf } from "../select";
import { CliError, type CommandSpec, type ParsedArgs, COMMAND } from "../types";
import { TRY_OPTION, requireTry } from "./shared";

const FORMATS = ["jpg", "png", "tiff", "webp"] as const;
const SPACES = ["srgb", "display-p3", "adobe-rgb", "prophoto-rgb"] as const;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"]);

function oneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  const found = allowed.find((a) => a === value.toLowerCase());
  if (!found) throw new CliError(1, `--${flag} ${value} isn't one of ${allowed.join(", ")}.`);
  return found;
}

function numberIn(flag: string, value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new CliError(1, `--${flag} takes a number from ${min} to ${max}.`);
  }
  return value;
}

/** Only what the person typed: the engine fills the rest from Preferences ▸ Export. */
export function exportSettings(args: ParsedArgs): ExportWireSettings {
  const o = args.options;
  const settings: ExportWireSettings = {};
  if (typeof o.format === "string") settings.format = oneOf("format", o.format === "jpeg" ? "jpg" : o.format, FORMATS);
  if (o.quality !== undefined) settings.quality = Math.round(numberIn("quality", o.quality, 1, 100));
  if (o["long-edge"] !== undefined) settings.longEdge = Math.round(numberIn("long-edge", o["long-edge"], 1, 100000));
  if (o.size !== undefined) {
    if (o.size !== "original") throw new CliError(1, `--size ${String(o.size)} isn't a size.`, "Use --size original, or --long-edge <px>.");
    if (settings.longEdge !== undefined) throw new CliError(1, "--size original and --long-edge disagree.");
    settings.longEdge = "original";
  }
  if (typeof o["colour-space"] === "string") settings.colourSpace = oneOf("colour-space", o["colour-space"], SPACES);
  if (o["bit-depth"] !== undefined) {
    if (o["bit-depth"] !== 8 && o["bit-depth"] !== 16) throw new CliError(1, "--bit-depth is 8 or 16.");
    settings.bitDepth = o["bit-depth"];
  }
  if (typeof o.name === "string") settings.nameTemplate = o.name;
  if (typeof o.existing === "string") settings.existing = oneOf("existing", o.existing, ["number", "replace"] as const);
  return settings;
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

export function exportTarget(output: unknown, cwd: string, photoCount: number): ExportTarget {
  if (output === undefined) return { kind: "dir", dir: cwd };
  if (typeof output !== "string" || output === "") throw new CliError(1, "-o takes a folder, a file name, or - for stdout.");
  if (output === "-") {
    if (photoCount !== 1) throw new CliError(1, `-o - writes one image, and this is ${photoCount}.`, "Name one photo, or use -o <folder>.");
    return { kind: "stdout" };
  }
  const path = resolve(cwd, output);
  const looksLikeFile = IMAGE_EXTENSIONS.has(extname(path).toLowerCase()) && !isDirectory(path);
  if (!looksLikeFile) return { kind: "dir", dir: path };
  if (photoCount !== 1) throw new CliError(1, `${output} is a file name, and there are ${photoCount} photos.`, "Use -o <folder>.");
  return { kind: "file", path };
}

interface PhotoResult {
  photo: string;
  ok: boolean;
  path?: string;
  width?: number;
  height?: number;
  colourSpace?: string;
  bytes?: number;
  error?: string;
}

export const exportPhotosCommand: CommandSpec = {
  verb: "export",
  group: "Output",
  summary: "Renders through Safelight's export, with Preferences ▸ Export as the defaults.",
  usage: "export <photos> [-o dir|file|-] [options]",
  examples: [
    `${COMMAND} export IMG_4021.ARW -o ~/out --format jpg --quality 90 --long-edge 3000`,
    `${COMMAND} export . --flag pick -o ../web --long-edge 2048`,
  ],
  options: [
    ...PHOTO_OPTIONS,
    { name: "output", alias: "o", kind: "string", summary: "A folder, a file, or - for stdout." },
    { name: "format", kind: "string", summary: "jpg, png, tiff or webp." },
    { name: "quality", kind: "number", summary: "1-100, for JPEG and WebP." },
    { name: "long-edge", kind: "number", summary: "The long edge in pixels." },
    { name: "size", kind: "string", summary: "original: full size." },
    { name: "colour-space", kind: "string", summary: "srgb, display-p3, adobe-rgb or prophoto-rgb." },
    { name: "bit-depth", kind: "number", summary: "8 or 16, for PNG and TIFF." },
    { name: "name", kind: "string", summary: "A filename template id an extension registered." },
    { name: "existing", kind: "string", summary: "When the file exists: number or replace." },
    TRY_OPTION,
  ],
  writes: false,
  async run(ctx, args) {
    const settings = exportSettings(args);
    requireTry(args);
    const request = buildSelectRequest(args, args.positionals, await stdinPathsOf(ctx, args));
    const selection = await ctx.select.read(request);
    const results: PhotoResult[] = [];
    try {
      const total = selection.groups.reduce((n, g) => n + g.photos.length, 0);
      if (total === 0 && selection.missing[0]) throw missingError(selection.missing[0]);
      if (total === 0) throw new CliError(2, "No photos to export.", "Name photos, or use --all.");
      for (const m of selection.missing) {
        const problem = missingError(m);
        results.push({ photo: m.spec, ok: false, error: problem.message });
        ctx.out.error({ message: problem.message, hint: problem.hint });
      }
      const target = exportTarget(args.options.output, ctx.env.cwd, total);
      if (target.kind === "stdout" && (ctx.env.isTTY.stdout || ctx.json)) {
        throw new CliError(1, "Not writing an image to the terminal.", `Redirect it: ${COMMAND} export IMG_4021.ARW -o - > out.jpg`);
      }
      let done = 0;

      for (const group of selection.groups) {
        const project = group.session.project;
        const names = new Map(group.photos.map((p) => [p.id, p.relPath]));
        let overrides: LookOverride | undefined;
        if (args.assignments.length) {
          if (total > 1) throw new CliError(1, "--try renders one photo at a time.", "Name one photo.");
          overrides = await tryOverrides(
            { projects: ctx.projects, values: ctx.values, out: ctx.out, strict: ctx.strict },
            project,
            group.photos[0],
            args.assignments,
          );
        }
        const frames = new Map<number, Uint8Array>();
        const stdoutFrames: number[] = [];
        const events = ctx.engine().request({
          id: newRequestId(),
          type: "export",
          project: projectWire(project),
          photoIds: group.photos.map((p) => p.id),
          settings,
          target,
          overrides,
        });
        for await (const item of events) {
          if (isFrame(item)) {
            frames.set(item.frame, item.bytes);
          } else if (item.type === "progress") {
            ctx.out.progress({ label: "Exporting", done: done + item.done, total });
          } else if (item.type === "exported") {
            noteExported(item);
          } else if (item.type === "error") {
            if (item.photoId === undefined) throw engineError(item);
            const photo = names.get(item.photoId) ?? item.photoId;
            results.push({ photo, ok: false, error: item.message });
            ctx.out.error({ message: `${photo}: ${item.message}` });
          }
        }
        for (const frame of stdoutFrames) {
          const bytes = frames.get(frame);
          if (!bytes) throw new CliError(3, "The engine finished without sending the image.");
          ctx.out.writeRaw(bytes);
        }
        done += group.photos.length;

        function noteExported(item: Extract<EngineEvent, { type: "exported" }>): void {
          if (item.frame !== undefined) stdoutFrames.push(item.frame);
          results.push({
            photo: names.get(item.photoId) ?? item.photoId,
            ok: true,
            path: item.path,
            width: item.width,
            height: item.height,
            colourSpace: item.colourSpace,
            bytes: item.bytes,
          });
          if (item.path !== undefined && !ctx.json) {
            ctx.out.print(ctx.out.exported({ path: item.path, width: item.width, height: item.height, colourSpace: item.colourSpace, bytes: item.bytes }));
          }
        }
      }
      ctx.out.progress(null);

      const failed = results.filter((r) => !r.ok).length;
      if (ctx.json) ctx.out.json({ slu: 1, photos: results });
      else if (total > 1) ctx.out.print(ctx.out.summary({ photos: total, stepEach: false, failed, skipped: 0 }));
      return { code: failed === 0 ? 0 : failed === results.length ? 2 : 6 };
    } finally {
      ctx.out.progress(null);
      await selection.close();
      await ctx.engine().shutdown();
    }
  },
};
