// Render-pipeline engine: extensions register display transforms (tone
// mappers) through the registry; the active choice is persisted and shared
// across windows like themes. The WebGLRenderer reads the resolved pipeline
// on every render and swaps to a cached program when it changes.

import { create } from "zustand";
import { useRegistry } from "./registry";

const PIPELINE_KEY = "sl_pipeline";
/** Resolution fallback when nothing (or a missing id) is selected: the stock
 *  Safelight transform baked into the fragment shader. */
export const DEFAULT_PIPELINE = "core.pipeline";

export const usePipelineStore = create<{ activeId: string }>(() => ({
  activeId: DEFAULT_PIPELINE,
}));

export interface ResolvedPipeline {
  id: string;
  /** GLSL defining pipelineToDisplay, or null for the built-in transform. */
  glsl: string | null;
  skipBaseCurve: boolean;
  /** Change signature the renderer compares against its compiled programs. */
  sig: string;
}

/** Stable identity for the built-in fallback (sig "" = stock program). */
export const BUILTIN_RESOLVED: ResolvedPipeline = {
  id: DEFAULT_PIPELINE,
  glsl: null,
  skipBaseCurve: false,
  sig: "",
};

// resolveActivePipeline runs on every renderer frame; memoize on the two
// store references so the steady-state cost is two getState calls and two
// identity compares (no string building).
let memo: ResolvedPipeline = BUILTIN_RESOLVED;
let memoId = "";
let memoReg: unknown = null;

/** Active pipeline, falling back to the built-in transform when the selected
 *  id isn't registered (e.g. its extension was disabled). */
export function resolveActivePipeline(): ResolvedPipeline {
  const id = usePipelineStore.getState().activeId;
  const reg = useRegistry.getState().pipelines;
  if (memoId === id && memoReg === reg) return memo;
  const c = reg[id];
  memo =
    !c || !c.glsl
      ? BUILTIN_RESOLVED
      : {
          id,
          glsl: c.glsl,
          skipBaseCurve: c.skipBaseCurve ?? false,
          sig: `${id}\n${c.glsl}`,
        };
  memoId = id;
  memoReg = reg;
  return memo;
}

export function applyPipeline(id: string): void {
  usePipelineStore.setState({ activeId: id });
  try {
    localStorage.setItem(PIPELINE_KEY, id);
  } catch {}
}

/** Restore the saved choice and follow changes from other windows. */
export function initPipelines(): void {
  try {
    const saved = localStorage.getItem(PIPELINE_KEY);
    if (saved) usePipelineStore.setState({ activeId: saved });
  } catch {}
  window.addEventListener("storage", (e) => {
    if (e.key === PIPELINE_KEY && e.newValue)
      usePipelineStore.setState({ activeId: e.newValue });
  });
}
