// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Developer Tools ▸ Pipeline: the develop program the open photo renders with,
// or the one any process version would, as describePipeline reads it from the
// calls the renderer makes: the core blocks in order, the stages between them,
// the conversions, and every clip of the colour.

import { useMemo, useState } from "react";
import { DEFAULT_DEVELOP_PARAMS, type DevelopParams } from "@/catalog/types";
import { COLOR_SPACES, type DisplaySpace } from "@/rendering/color-space";
import { useDisplayProfile } from "@/rendering/display-profile-store";
import { useDisplaySpace } from "@/rendering/display-space";
import { spaceKey } from "@/rendering/stage-space";
import { maskInstances } from "@/rendering/webgl/mask-stage-instances";
import { describePipeline, type ClipWhen, type PipelineRow } from "@/rendering/webgl/pipeline-description";
import { shaderVariantFor, type ProcessVersion } from "@/rendering/webgl/shaders";
import { useDevelopStore } from "@/state/develop-store";
import { resolvePipelineFor, usePipelineStore } from "../pipelines";
import { useRegistry } from "../registry";
import { isDevtoolsWindow } from "./detach";

type Row<K extends PipelineRow["kind"]> = Extract<PipelineRow, { kind: K }>;

/** Where the view's frames go. */
export interface ScreenTarget {
  space: DisplaySpace;
  /** The active monitor profile's description; null without one. */
  profile: string | null;
}

/** A row with the rows that belong to it: a core block's transform and clips,
 *  a stage's clips, the output's clips. */
interface Item {
  head: PipelineRow;
  under: PipelineRow[];
}

const VERSIONS: readonly ProcessVersion[] = [1, 2, 3];
// Picking version 3 shows it, though no photo can be on it yet.
const NEWEST: ProcessVersion = 3;

const WHERE: Record<Row<"clamp">["where"], string> = {
  input: "input",
  result: "result",
  "pass-input": "what its passes read, not the frame",
};
const WHEN: Record<ClipWhen, string> = {
  always: "always",
  "while-active": "while in use",
  "per-mask": "inside each mask that uses it, blended by coverage",
  "fallback-preview": "fallback preview only",
  "non-srgb-output": "only when the output isn't sRGB",
  "no-float-targets": "only without float render targets or mipmaps",
};

/** Each row under the one it belongs to. A stage's clips are found by its id,
 *  not by position: a reader's pass clip is written ahead of the first
 *  output-frame stage, which need not be the reader. */
function itemsOf(rows: readonly PipelineRow[]): Item[] {
  const items: Item[] = [];
  const stages = new Map<string, Item>();
  const owned: Row<"clamp">[] = [];
  let core: Item | undefined;
  for (const row of rows) {
    if (row.kind === "clamp" && row.reason !== "core") {
      owned.push(row);
    } else if (core && (row.kind === "transform" || row.kind === "clamp")) {
      core.under.push(row);
    } else {
      const item: Item = { head: row, under: [] };
      items.push(item);
      if (row.kind === "core") core = item;
      if (row.kind === "stage") stages.set(row.id, item);
    }
  }
  const output = items.find((i) => i.head.kind === "output");
  for (const clamp of owned) {
    const owner = "stageId" in clamp ? stages.get(clamp.stageId) : output;
    if (owner) owner.under.push(clamp);
    else items.push({ head: clamp, under: [] });
  }
  return items;
}

const CHIP = "rounded bg-surface-3 px-1 text-text-secondary";

function StageView({ row }: { row: Row<"stage"> }) {
  const { domain } = row;
  const facts = [
    row.owner ?? "Safelight",
    `${row.phase}, priority ${row.priority}`,
    // A geometry stage moves pixels and holds no colour.
    ...(domain ? [row.space ? spaceKey(row.space, domain) : `${domain} values`] : []),
    ...(row.reads === "current" ? ["reads the current image"] : []),
    ...(row.maskable && row.copies ? [`per mask, ${row.copies} ${row.copies === 1 ? "copy" : "copies"}`] : []),
    ...(row.maskable && !row.copies ? ["maskable"] : []),
  ];
  return (
    <>
      <div className="flex items-baseline gap-2">
        <span className="text-text-primary">{row.name}</span>
        <span className="font-code text-[10px] text-text-muted">{row.id}</span>
      </div>
      <div className="flex flex-wrap gap-x-2.5 text-[10px] text-text-secondary">
        {facts.map((fact) => (
          <span key={fact}>{fact}</span>
        ))}
      </div>
      {row.note && <div className="text-[10px] text-text-muted">{row.note}</div>}
      {row.floors.map((floor, i) => (
        <div key={i} className="font-code text-[10px] text-amber-400">{`found in GLSL: ${floor}`}</div>
      ))}
    </>
  );
}

function ClipView({ row, screen }: { row: Row<"clamp">; screen: ScreenTarget }) {
  return (
    <div>
      <span className={CHIP}>{`${WHERE[row.where]} · ${WHEN[row.when]}`}</span>
      {/* The export's space isn't known until an export, but the view's is. */}
      {row.when === "non-srgb-output" && (
        <span className={`ml-1.5 ${screen.profile ? "text-amber-400" : "text-text-muted"}`}>
          {screen.profile ? "Runs for this screen's monitor profile." : "Doesn't run for this screen."}
        </span>
      )}
      <span className="ml-1.5 text-text-muted">{row.detail}</span>
    </div>
  );
}

function OutputView({ row, screen }: { row: Row<"output">; screen: ScreenTarget }) {
  const target = screen.profile
    ? `${screen.profile} (monitor profile)`
    : (COLOR_SPACES.find((s) => s.value === screen.space)?.label ?? screen.space);
  return (
    <>
      <div className="flex items-baseline gap-2">
        <span className="text-text-muted">Output</span>
        <span className={`${CHIP} text-[10px]`}>{row.mapped ? "mapped" : "clipped"}</span>
      </div>
      <div className="text-[10px] text-text-muted">{row.detail}</div>
      {row.mapped && <div className="text-[10px] text-text-secondary">{`On this screen: ${target}`}</div>}
    </>
  );
}

function RowView({ row, screen }: { row: PipelineRow; screen: ScreenTarget }) {
  switch (row.kind) {
    case "core":
      return (
        <div className="text-text-muted">
          <span>{row.label}</span>
          {row.note && <span className="ml-2 text-[10px]">{row.note}</span>}
        </div>
      );
    case "stage":
      return <StageView row={row} />;
    case "convert":
      return (
        <div className="pl-3 font-code text-[10px] text-text-secondary">
          {row.elided ? `stays in ${row.to}` : `${row.from} → ${row.to}`}
        </div>
      );
    case "clamp":
      return <ClipView row={row} screen={screen} />;
    case "transform":
      return (
        <div className="flex flex-wrap gap-x-2.5 text-text-secondary">
          <span>{`Transform: ${row.id ?? "Built-in"}`}</span>
          {row.flags.map((f) => (
            <span key={f.flag} className={f.honoured ? "" : "text-amber-400"}>
              {`${f.flag}: ${f.honoured ? "honoured" : "ignored on this version"}`}
            </span>
          ))}
        </div>
      );
    case "output":
      return <OutputView row={row} screen={screen} />;
  }
}

export function PipelineView({
  rows,
  version,
  onVersion,
  photoVersion = null,
  screen = { space: "srgb", profile: null },
  popped = false,
}: {
  rows: readonly PipelineRow[];
  version: ProcessVersion;
  onVersion: (version: ProcessVersion) => void;
  /** The open photo's version; null with no photo open. */
  photoVersion?: ProcessVersion | null;
  screen?: ScreenTarget;
  /** In the popped-out Developer Tools window, which has no photo open though
   *  the main window may. */
  popped?: boolean;
}) {
  const items = useMemo(() => itemsOf(rows), [rows]);
  const photoNote = photoVersion
    ? `Open photo: v${photoVersion}`
    : popped
      ? "Dock Developer Tools to see the open photo."
      : "No photo open";
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border-subtle px-2 py-1.5">
        <span className="text-text-muted">Process version</span>
        {VERSIONS.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => onVersion(v)}
            aria-pressed={v === version}
            className={`rounded px-1.5 py-0.5 ${
              v === version ? "bg-surface-3 text-text-primary" : "text-text-muted hover:text-text-secondary"
            }`}
          >
            v{v}
          </button>
        ))}
        <span className="ml-auto text-text-muted">{photoNote}</span>
      </div>
      <ol aria-label="Pipeline" className="min-h-0 flex-1 overflow-y-auto">
        {items.map(({ head, under }, i) => (
          <li key={i} className="border-b border-border-subtle/50 px-2 py-1">
            <RowView row={head} screen={screen} />
            {under.length > 0 && (
              <ul className="mt-0.5 space-y-px pl-3 text-[10px]">
                {under.map((row, j) => (
                  <li key={j}>
                    <RowView row={row} screen={screen} />
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** One of the open photo's params (the current default's with none open).
 *  Selected one at a time, so an edit to any other param, which swaps the
 *  params object, doesn't render the tab. */
const useOpenParam = <K extends keyof DevelopParams>(key: K): DevelopParams[K] =>
  useDevelopStore((s) => (s.photoId ? s.params : DEFAULT_DEVELOP_PARAMS)[key]);

// The renderer encodes version 3 frames for the display space only where it can
// tag the drawing buffer with it (its canTagBuffer, which resolves through this
// prototype). Anywhere else they are sRGB.
const canTagDrawingBuffer = (): boolean =>
  typeof WebGL2RenderingContext !== "undefined" && "drawingBufferColorSpace" in WebGL2RenderingContext.prototype;

/** The program for the open photo (the current defaults with none open), from
 *  the stores the render bridge feeds the renderer from. */
export function PipelineTab() {
  const registered = useRegistry((s) => s.processingStages);
  const transforms = useRegistry((s) => s.pipelines);
  const defaultTransform = usePipelineStore((s) => s.activeId);
  const photoId = useDevelopStore((s) => s.photoId);
  const processVersion = useOpenParam("processVersion");
  const masks = useOpenParam("masks");
  const displayTransform = useOpenParam("displayTransform");
  const space = useDisplaySpace();
  const profile = useDisplayProfile((s) => (s.status === "active" ? s.description : null));

  const photoVersion = shaderVariantFor(processVersion).version;
  // A pick holds for the photo and version it was made on, and is forgotten
  // once either is left: opening another photo, or updating this one's
  // processing, shows that photo's own version, and so does coming back to it.
  const [pick, setPick] = useState<{ version: ProcessVersion; on: string } | null>(null);
  const on = `${photoId}:${photoVersion}`;
  if (pick && pick.on !== on) setPick(null);
  const version = pick?.on === on ? pick.version : photoVersion;

  // The registered transforms and the Preferences default decide which one
  // resolvePipelineFor returns.
  const pipeline = useMemo(
    () => resolvePipelineFor(displayTransform),
    [displayTransform, transforms, defaultTransform],
  );
  const variant = shaderVariantFor(version, NEWEST);
  // The stages as render-bridge posts them to the worker, with the copies the
  // photo's masks call for, as the renderer builds its program. Every brush dab
  // replaces the masks but rarely the copies, so the rows key on the copies'
  // sig, as the renderer keys its injection.
  const copies = maskInstances(Object.values(registered), masks, variant);
  const rows = useMemo(
    () => describePipeline(copies.stages, variant, pipeline),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registered, copies.sig, version, pipeline],
  );

  return (
    <PipelineView
      rows={rows}
      version={version}
      onVersion={(v) => setPick({ version: v, on })}
      photoVersion={photoId ? photoVersion : null}
      screen={{ space: canTagDrawingBuffer() ? space : "srgb", profile }}
      popped={isDevtoolsWindow()}
    />
  );
}
