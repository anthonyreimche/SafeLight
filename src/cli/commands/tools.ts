// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { currentLook } from "@/catalog/edit-steps";
import type { StoredLook } from "@/catalog/stored-edit-look";
import type { CatalogPhoto } from "@/catalog/types";
import type { PhotoHeader, ToolRow, ValueRow } from "../output/types";
import { isEdited, selectOnePhoto } from "../select";
import type { CommandContext, CommandSpec, ToolRef, ValueInfo } from "../types";
import { asShotOf, photoName } from "./edit-shared";
import { PROJECT_OPTION } from "./shared";
import { COMMAND } from "../types";

export function photoHeaderOf(photo: CatalogPhoto, look: StoredLook, edited: boolean): PhotoHeader {
  const { cameraMake, cameraModel } = photo.exif;
  const camera = cameraModel && cameraMake && !cameraModel.toLowerCase().startsWith(cameraMake.toLowerCase())
    ? `${cameraMake} ${cameraModel}`
    : cameraModel ?? cameraMake;
  return {
    name: photoName(photo),
    camera,
    megapixels: photo.width > 0 && photo.height > 0 ? (photo.width * photo.height) / 1e6 : undefined,
    edited,
    processVersion: look.params.processVersion,
  };
}

function valueRow(ctx: CommandContext, look: StoredLook, asShot: number, info: ValueInfo, keptNote?: string): ValueRow {
  const notes: string[] = [];
  if (info.key === "temperature") notes.push(`(as shot ${Math.round(asShot)})`);
  if (!info.settable) notes.push("(edit in Safelight)");
  if (keptNote) notes.push(keptNote);
  return {
    info,
    value: ctx.values.read(look, info),
    changed: !ctx.values.isDefault(look, info, asShot),
    note: notes.length > 0 ? notes.join(" ") : undefined,
  };
}

function toolState(tool: ToolRef, anyChanged: boolean): ToolRow["state"] {
  if (!tool.installed) return "not installed";
  if (!tool.enabled) return "off";
  return tool.kind === "core" || anyChanged ? "in use" : "idle";
}

/** The tools of a photo's look in pipeline order. Core tools always show; an
 *  extension shows when the edit uses it, or with `all`. */
export function toolRows(ctx: CommandContext, look: StoredLook, asShot: number, all: boolean): ToolRow[] {
  const rows: ToolRow[] = [];
  for (const tool of ctx.values.tools()) {
    const values = ctx.values.values(tool.id).map((info) => valueRow(ctx, look, asShot, info));
    const anyChanged = values.some((v) => v.changed);
    const state = toolState(tool, anyChanged);
    if (!tool.installed) {
      // The edit still holds these values; they are kept until the tool is back.
      const kept = values.filter((v) => v.changed).map((v) => ({ ...v, note: "(not installed, values kept)" }));
      if (kept.length > 0 || all) rows.push({ tool: tool.name, state, values: kept });
    } else if (state === "in use" || all || anyChanged) {
      rows.push({ tool: tool.name, state, values });
    }
  }
  return rows;
}

/** The named values, grouped by tool in the order the keys were given. */
export function namedRows(ctx: CommandContext, look: StoredLook, asShot: number, infos: ValueInfo[]): ToolRow[] {
  const rows = new Map<string, ToolRow>();
  for (const info of infos) {
    let row = rows.get(info.tool.id);
    if (!row) rows.set(info.tool.id, (row = { tool: info.tool.name, values: [] }));
    row.values.push(valueRow(ctx, look, asShot, info));
  }
  return [...rows.values()];
}

export function valueJson(row: ValueRow): Record<string, unknown> {
  const { info } = row;
  return {
    key: info.key,
    label: info.label,
    value: row.value,
    changed: row.changed,
    kind: info.kind,
    ...(info.min !== undefined && { min: info.min }),
    ...(info.max !== undefined && { max: info.max }),
    ...(info.unit !== undefined && { unit: info.unit }),
    ...(info.choices !== undefined && { choices: info.choices.map((c) => c.value) }),
    settable: info.settable,
  };
}

export function toolsJson(rows: ToolRow[]): Record<string, unknown>[] {
  return rows.map((r) => ({ name: r.tool, state: r.state ?? "in use", values: r.values.map(valueJson) }));
}

export const toolsCommand: CommandSpec = {
  verb: "tools",
  group: "Look",
  summary: "Lists the tools in pipeline order. With a photo: each value with its range and unit, and a ✱ by values away from their default.",
  usage: "tools [photo] [--all]",
  examples: [
    `${COMMAND} tools IMG_4021.ARW`,
    `${COMMAND} tools IMG_4021.ARW --all`,
  ],
  options: [
    PROJECT_OPTION,
    { name: "all", kind: "flag", summary: "Also list idle tools." },
  ],
  writes: false,
  async run(ctx, args) {
    const spec = args.positionals[0];
    const hasPhoto = spec !== undefined || args.stdinList || args.afterDashDash.length > 0;

    if (!hasPhoto) {
      const tools = ctx.values.tools();
      const rows: ToolRow[] = tools.map((t) => ({
        tool: t.name,
        state: !t.installed ? "not installed" : !t.enabled ? "off" : undefined,
        values: [],
      }));
      if (!ctx.json) ctx.out.print(ctx.out.toolTable(rows));
      return {
        code: 0,
        json: {
          slu: 1,
          tools: tools.map((t) => ({ id: t.id, name: t.name, kind: t.kind, installed: t.installed, enabled: t.enabled, settable: t.settable })),
        },
      };
    }

    const one = await selectOnePhoto(ctx, args, spec, { allMeansEverything: false });
    try {
      const { photo, session } = one;
      const asShot = asShotOf(photo);
      const state = await session.edit(photo.id);
      const look = currentLook(state, asShot);
      const rows = toolRows(ctx, look, asShot, args.options.all === true);
      const header = photoHeaderOf(photo, look, isEdited(state));
      if (!ctx.json) {
        ctx.out.print(ctx.out.photoHeader(header));
        ctx.out.print(ctx.out.toolTable(rows));
        if (args.options.all !== true) ctx.out.info(`${COMMAND} tools --all lists idle tools too.`);
      }
      return {
        code: 0,
        json: { slu: 1, photo: photo.relPath, edited: header.edited, processVersion: header.processVersion, tools: toolsJson(rows) },
      };
    } finally {
      await one.close();
    }
  },
};
