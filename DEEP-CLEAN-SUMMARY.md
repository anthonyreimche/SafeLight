# Safelight deep-clean — final summary

Whole-project audit for the bug class that started this (a hidden cap silently
degrading output), plus hardcoded values, duplication, and AI-slop. Scanned all
211 `src` files + `electron/`, verified findings adversarially, fixed in risk
tiers, and rescanned every behavioral change.

## What landed (applied, `tsc` + all tests green)

| Tier | Fixes | Notes |
| --- | --- | --- |
| A — safe cleanups | 42 | duplication → 7 shared modules, dead code, constant drift |
| B — behavioral bugs | 115 | one file per fixer, cross-file edits flagged not forced |
| Cross-file clusters | 24 | coordinated multi-file fixes |
| Rescan repairs | 3 | 1 real regression (reduce-motion race) + 2 minors |

~184 fixes across ~70 files. Full detail: `AUDIT-REPORT.md` (all findings),
`CROSS-FILE-WORKLIST.md` (multi-file remainders + Tier-B fix log). Everything is
staged in the working tree — reviewable with `git diff`, revertible per-file.

Highlights: the libraw→in-house RAW fallback chain (dead because the wasm adapter
detached the buffer); ZIP export corrupting past 4 GiB; Electron plugin-install
path traversal (Windows backslash + prefix escape); object-URL / GL-texture / IDB
leaks; cross-window preset/extension staleness; the `imageAspect`-from-metadata
transpose bug in Crop/Transform; hung `computeUpright`/capture promises.

## Render tier — APPLIED, awaiting your in-app batch-verification

19 of 21 render fixes applied and built into `dist/` (you chose apply-all +
batch-verify). `tsc` + tests green, diff-rescanned. Two were correctly refused:
`developedTex`→RGBA16F (would black-frame — that target is `generateMipmap`-ed
every frame and WebGL2 can't mipmap RGBA16F; needs a manual float mip chain) and
the `applyMaskDisplay` dedup (blocks aren't actually identical). The heal-banding
issue `developedTex` describes is therefore still open — noted below.

Verify after relaunch (grouped by where to look):
- **Effects ▸ Grain**: Amount ≈ 50, zoom 100%, sweep **Color** 0→100 — neutral
  grain should turn chromatic (was a dead no-op).
- **Tone Curve**: hard pull in deep shadows — smoother gradient, less banding.
- **Detail / extension prepasses**: halation/bloom and any separable H/V blur
  (e.g. Spektrafilm) render correctly (was a program-cache collision); a prepass
  driven by a boolean/vector param now actually engages.
- **Masks/Retouch**: brush dabs stay correctly shaped after a RAW's full decode
  swaps in over its preview (coverage-aspect fix); a 5th+ brush component
  contributes nothing rather than borrowing channel 1.
- **Preferences ▸ High bit depth**: toggle off/on, reopen a photo — gradient
  smoothness should now actually change (was hardcoded on in the worker).
- **Export**: a huge non-RAW image renders instead of black (bitmap size cap); a
  JPEG exported in Adobe RGB reads correctly in metadata tools (ICC segment order).
- **Heal**: healing a large area shouldn't smear synthetic fill as "texture".

The originals for these live below for reference.

### 1. Render — now APPLIED (was "still open")

- **`developedTex` heal-banding** (`renderer.ts` `prepareDevelopedTarget`): FIXED.
  Rather than a manual float mip chain, the patched-source target is now RGBA16
  (norm16) when available — 16-bit (no banding), and unlike RGBA16F it is
  colour-renderable, filterable AND GPU-mipmappable, so the per-frame
  `generateMipmap` and same linear/[0,1] semantics are preserved. Falls back to
  RGBA8 if the 16-bit target isn't framebuffer-complete on the device.
  **Verify:** add a heal/retouch spot over a smooth gradient (sky / soft
  background) under a strong exposure push — the gradient should stay smooth
  instead of banding once a spot exists.

### 1b. Original render findings (reference)

**High-value behavioral (the slider/output actually misbehaves):**
- `renderer.ts:1887` — **Grain "Color" slider is a total no-op** (`uGrainColor`
  never registered). Fix: add `"uGrainColor"` to `cacheUniformsFor`. Trivial + high value.
- `renderer.ts:2661` — **`developedTex` is RGBA8**, so a single heal spot routes
  the whole 16F linear chain through an 8-bit clamped copy → banding / HDR loss.
  Fix: allocate RGBA16F when `haveColorBufferFloat`.
- `renderer.ts:837` + `mask-coverage.ts:26` — coverage atlas cached without
  `imageAspect`; orientation-divergent decode → stretched brush/retouch dabs.
- `renderer.ts:2582` — prepass program cache keyed on source *length*; separable
  H/V blur passes (identical length) reuse the wrong compiled program.
- `renderer.ts:2520` — `prepassActive` only counts non-zero numbers; boolean/
  vector-driven prepass stages never run.
- `shaders.ts:947` — mask Highlights/Shadows knee no longer matches the global
  slider (global moved to the filmic shoulder; mask path kept the legacy curve).
- `shader-compiler.ts:66,76` — stage-uniform namespacing uses substring replace
  (no word boundaries) and the return-type regex omits `mat2`/`uint`; both can
  corrupt injected extension-stage GLSL.
- `mask-coverage.ts:56` — brush components beyond 4 render with component 0's
  coverage (silent, no cap enforced in UI).
- `curve.ts:129` — RGB curve LUT double-quantizes to 8-bit twice; posterizes
  crushed shadows vs composing in float.
- `color-space.ts:304` — embedded-ICC JPEG puts APP2 before JFIF/EXIF APP0/APP1,
  violating the spec; strict parsers can misread EXIF.
- `content-aware-fill.ts:99` — hole-seed give-up fallback can seed inside the
  hole, propagating synthetic pixels as "known" texture.
- Deferred render-path items from Tier B (same reason): `bindSource` losing
  `maxEdge` (stale output cap — the export-bug class), 8-bit bitmap upload
  ignoring `maxEdge` (black-frame risk), stage-texture/prepass overflow rendering
  garbage, `sourceEpoch` prefetch churning prepass caches, and the **"High bit
  depth" preference never reaching the worker** (hardcoded `true`).

**Pixel-neutral cleanups (safe, but in shader files — mechanical):**
- `shaders.ts:239` — 9 dead GLSL functions (compiler already elides them).
- `shaders.ts:185` — dead `uHealFill`/`uHaveHealFill`/`uRetouchRadius` uniforms +
  their renderer upload scaffolding (silent no-ops).
- `shaders.ts:987` — `applyMaskDisplay` duplicates main()'s Whites/Blacks/Dehaze/
  Texture blocks (~40 lines); extract shared helpers.
- `shaders.ts:150,325` — stale doc comments (`uSharpenViz` missing mode 4; knee
  says 0.30, code is 0.25).

I can apply any of these as isolated, reversible commits for you to verify in the
running app — say the word and I'll start with Grain Color + `developedTex`.

### 2. Security / trust-model — design decision

- `electron/main.cjs` install — the install dir is keyed solely by the
  attacker-controlled `manifest.id`, and install begins with `rmSync` of that
  dir, so any repo can declare an installed (even verified) extension's id and
  replace its code. The banned-list is the only gate. A fix needs a policy call:
  record the source repo per install and refuse cross-repo id overwrites unless
  the user confirms (which affects legit re-install / fork / rename flows).
  *(The path-traversal half is already fixed in Tier B.)*
- `electron/preload.cjs` — `plugins.install/uninstall` sit on the **unsealed**
  `safelightNative` surface, so any extension can install another whose manifest
  widens `connect-src` on next launch. Moving them behind `claimPrivileged`
  spans `privileged.ts`, `loader.ts`, `types.ts`, `preload.cjs`, `main.cjs`.

### 3. Deferred behavioral follow-up (non-pixel, subtle)

- Raising **"Cached preview resolution"** / **"Develop resolution"** still doesn't
  upgrade already-cached photos (cache key has no size component; forced re-cache
  skips present keys; the develop source cache key excludes `maxEdge`). Correct
  fix needs cap metadata stored per cache entry + a source-cache-key change —
  worth doing carefully as its own change since a wrong invalidation regresses
  decode performance. The misleading Preferences hint is already corrected.
