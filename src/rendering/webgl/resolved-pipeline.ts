// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { ContributedBinding } from "./stage-injection";

export interface ResolvedPipeline {
  id: string;
  /** GLSL defining pipelineToDisplay, or null for the built-in transform. */
  glsl: string | null;
  skipBaseCurve: boolean;
  skipToneShoulder: boolean;
  /** The uniforms the transform's GLSL reads, declared under its namespace.
   *  Empty ("", and `bindings` []) for a transform with helpers that declares
   *  none; absent without glsl, or with neither declarations nor helpers. */
  uniformDecls?: string;
  /** The bag key each of those uniforms binds from, and its default. */
  bindings?: readonly ContributedBinding[];
  /** Change signature the renderer caches its compiled programs and their
   *  flags by: it differs whenever the shader or either flag does. */
  sig: string;
}
