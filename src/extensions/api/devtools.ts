// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What api.devtools reads: the develop program's rows, shared-variable
// history and the GPU's details.

import type { DisplaySpace } from "@/rendering/color-space";
import type { ProcessingPhase, StageSpace } from "./contributions";
import type {
  VariableRevision,
  VariableSnapshot,
  VariableWriter,
} from "./variables";

export type ProcessVersion = 1 | 2 | 3;

/** Whether a stage's block sees scene-linear or display-encoded values. */
export type StageDomain = "scene" | "display";

/** When a clip runs: on every frame; while the tool above it is in use; inside
 *  each mask that uses it, blended in by the mask's coverage; only for a
 *  fallback preview's source, which has no headroom above 1; only when the
 *  output isn't sRGB (an export to a wider space, or a monitor profile); only
 *  on a GPU without float render targets (or none it can mipmap), where an
 *  intermediate is stored in a format that holds [0, 1]. */
export type ClipWhen =
  | "always"
  | "while-active"
  | "per-mask"
  | "fallback-preview"
  | "non-srgb-output"
  | "no-float-targets";

/** One row of the develop program as the Pipeline tab lists it. */
export type PipelineRow =
  | { kind: "core"; label: string; note?: string }
  | {
      kind: "stage";
      id: string;
      name: string;
      phase: ProcessingPhase;
      priority: number;
      /** The extension that registered it; null for Safelight's own. */
      owner: string | null;
      space: StageSpace | null;
      /** The values its block sees: scene-linear `lin`, display-encoded `c`,
       *  or none for geometry, which moves pixels and holds no colour. */
      domain: StageDomain | null;
      reads: "source" | "current";
      maskable: boolean;
      /** Floors and clips found in its GLSL. */
      floors: string[];
      /** How many mask copies run it again. They have no rows of their own:
       *  `note` says what is written for each. */
      copies?: number;
      note?: string;
    }
  | { kind: "convert"; from: string; to: string; elided: boolean }
  | {
      kind: "clamp";
      /** One of the develop shader's own blocks (the core row above it), or
       *  the output encode. */
      reason: "core" | "output";
      /** The values coming in, or what the block made. */
      where: "input" | "result";
      when: ClipWhen;
      detail: string;
    }
  | {
      kind: "clamp";
      reason: "legacy-display-stage";
      /** The stage that declares no space. */
      stageId: string;
      /** Its block's input, or what its passes read (their split draw only,
       *  not the frame). */
      where: "input" | "pass-input";
      when: "always";
      detail: string;
    }
  | {
      kind: "clamp";
      /** A clip inside one of Safelight's own stages that a scan of its GLSL
       *  can't see, such as one in its passes. */
      reason: "builtin-stage";
      stageId: string;
      where: "result";
      when: "while-active";
      detail: string;
    }
  | {
      kind: "transform";
      /** null for the built-in transform. */
      id: string | null;
      /** The flags the transform sets, each with whether this version honours it. */
      flags: { flag: "skipBaseCurve" | "skipToneShoulder"; honoured: boolean }[];
    }
  | { kind: "output"; mapped: boolean; detail: string };

/** Where the view's frames go. */
export interface ScreenTarget {
  space: DisplaySpace;
  /** The active monitor profile's description; null without one. */
  profile: string | null;
}

export type VariableOutcome = "accepted" | "stale" | "invalid" | "lost";

export interface VariableHistoryItem {
  time: number;
  writer: VariableWriter;
  /** accepted and lost: the write's own revision. stale and invalid: the
   *  current revision the write was refused against. */
  revision: VariableRevision;
  outcome: VariableOutcome;
  /** stale: who wrote the revision the writer hadn't seen. lost: who won. */
  other?: VariableWriter;
  /** invalid: why. */
  message?: string;
}

export interface VariableInspection {
  snapshot: VariableSnapshot<unknown>;
  size: number;
  history: readonly VariableHistoryItem[];
  /** Extension ids subscribed in this window, in subscription order. */
  subscribers: string[];
}

/** Every shared variable in this window, as the Variables tab reads them. */
export interface VariablesInspector {
  inspect(): VariableInspection[];
  /** For useSyncExternalStore: fires on every change the Variables tab shows. */
  subscribeChanges(listener: () => void): () => void;
  changeCount(): number;
  /** "this window", another window's label, or the first four characters of its id. */
  windowName(id: string): string;
}

export interface WebGLInfo {
  vendor: string;
  renderer: string;
  glsl: string;
  maxTexture: number;
  /** MAX_FRAGMENT_UNIFORM_VECTORS: the develop program's uniforms must fit in it to link. */
  fragmentUniformVectors: number;
  /** EXT_color_buffer_float: without it the render pipeline's intermediates are 8-bit. */
  colorBufferFloat: boolean;
}
