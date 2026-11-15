// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Renders one photo through the engine and prints it in the terminal.

import type { CatalogPhoto } from "@/catalog/photo";
import { NEUTRAL_TEMPERATURE_K } from "@/catalog/defaults";
import { currentLook } from "@/catalog/edit-steps";
import type { EngineEvent, LookOverride, ProjectWire } from "@/engine/protocol";
import type { EngineClient, EngineFrame } from "./engine-client";
import type { Output } from "./output/types";
import {
  DEFAULT_CELL,
  detectGraphicsMode,
  encodeForTerminal,
  supportsTrueColour,
  type TerminalProbe,
} from "./terminal-image";
import {
  CliError,
  type Assignment,
  type CliEnv,
  type GraphicsMode,
  type PreviewService,
  type ProjectRef,
  type ProjectService,
  type ValueService,
} from "./types";

const MAX_COLUMNS = 120;

let nextRequestId = 1;
export const newRequestId = (): number => nextRequestId++;

export function projectWire(project: ProjectRef): ProjectWire {
  return { root: project.root, workingDir: project.workingDir, location: project.location };
}

export function asShotOf(photo: CatalogPhoto): number {
  return photo.exif.colorTemperature ?? NEUTRAL_TEMPERATURE_K;
}

/** The engine's own failures, as the exit codes cli-commands §3 names: the photo's fault is 2, the engine's is 3. */
export function engineError(event: Extract<EngineEvent, { type: "error" }>): CliError {
  const photoFault = event.code === "decode" || event.code === "project";
  return new CliError(photoFault ? 2 : 3, event.message);
}

export function isFrame(item: EngineEvent | EngineFrame): item is EngineFrame {
  return !("type" in item);
}

export interface TryServices { projects: ProjectService; values: ValueService; out: Output; strict: boolean }

/** The look with the `--try` values applied, for the engine to render without storing. */
export async function tryOverrides(
  services: TryServices,
  project: ProjectRef,
  photo: CatalogPhoto,
  assigns: Assignment[],
): Promise<LookOverride> {
  const session = await services.projects.openRead(project);
  let state;
  try {
    state = await session.edit(photo.id);
  } finally {
    await session.close();
  }
  const asShot = asShotOf(photo);
  const result = services.values.apply(currentLook(state, asShot), assigns, { asShot, strict: services.strict });
  for (const change of result.changes) {
    if (change.clamped) {
      services.out.warn({ message: `${change.info.label} ${change.clamped.requested} is past its limit, so it was set to ${services.out.formatValue(change.info, change.after)}.` });
    }
  }
  return { params: result.look.params, paramBag: result.look.paramBag };
}

function orientedAspect(photo: CatalogPhoto): number {
  const turned = photo.rotation % 180 !== 0;
  const w = turned ? photo.height : photo.width;
  const h = turned ? photo.width : photo.height;
  return w > 0 && h > 0 ? h / w : 2 / 3;
}

export type ResolveTry = (project: ProjectRef, photo: CatalogPhoto, assigns: Assignment[]) => Promise<LookOverride>;

export function createPreviewService(
  env: CliEnv,
  out: Output,
  engine: () => EngineClient,
  resolveTry?: ResolveTry,
  probe?: TerminalProbe,
): PreviewService {
  return {
    async show(project, photo, opts) {
      const detected = await detectGraphicsMode(env, opts.mode, probe);
      const mode: GraphicsMode = detected.mode;
      if (mode === "none") {
        out.warn({
          message: `Not showing the image: ${detected.reason}.`,
          hint: "slu export writes the photo to a file; --graphics blocks forces coloured blocks.",
        });
        return;
      }
      const overrides = opts.tryAssigns?.length
        ? await (resolveTry ?? (() => { throw new CliError(1, "--try isn't available here."); }))(project, photo, opts.tryAssigns)
        : undefined;

      const columns = Math.max(1, Math.min(opts.widthCols ?? out.options.width, MAX_COLUMNS));
      const cell = detected.cell ?? DEFAULT_CELL;
      const aspect = orientedAspect(photo);
      // a block cell is one pixel wide and two tall, so a pixel is square when the cell is 1:2
      const width = mode === "blocks" ? columns : columns * cell.width;
      let height = Math.max(1, Math.round(width * aspect));
      if (mode === "blocks" && height % 2 === 1) height += 1;

      const encoding = mode === "blocks" ? "rgba" : "png";
      const id = newRequestId();
      const started = Date.now();
      let frameInfo: Extract<EngineEvent, { type: "frame" }> | null = null;
      let bytes: Uint8Array | null = null;
      for await (const item of engine().request({ id, type: "preview", project: projectWire(project), photoId: photo.id, width, height, encoding, overrides })) {
        if (isFrame(item)) {
          if (frameInfo && item.frame === frameInfo.frame) bytes = item.bytes;
        } else if (item.type === "frame") {
          frameInfo = item;
        } else if (item.type === "error") {
          throw engineError(item);
        }
      }
      if (!frameInfo || !bytes) throw new CliError(3, "The engine finished without sending the image.");

      out.writeRaw(encodeForTerminal(mode, { width: frameInfo.width, height: frameInfo.height, encoding: frameInfo.encoding, bytes }, env));
      out.print(out.previewCaption({
        mode,
        trueColour: mode !== "blocks" || supportsTrueColour(env),
        width: frameInfo.width,
        height: frameInfo.height,
        ms: Date.now() - started,
      }));
    },
  };
}
