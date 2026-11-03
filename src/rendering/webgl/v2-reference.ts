// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Process version 2, frozen: SHA-256 of each normalized piece Safelight 3.0.1
// built for the fixtures in v2-identity.fixtures.ts. Run v2Snapshot() on the
// commit that adds this file for the text behind a hash; normalizeGlsl and the
// snapshot format are part of the freeze too.
//
// Edited on purpose. On 2026-10-26 Anthony moved the camera baseline
// (baseline-tone.ts) into version 2 so every RAW gets it, existing edits
// included. That changed the 18 `*/shader/*` hashes; the stage injections,
// their metadata and the pass programs stayed as 3.0.1 built them.
//
// Edited again on 2026-10-27, the same 18 hashes: the camera match learned a
// shadows lift for Active D-Lighting (uBaselineShadows), which the tone block
// applies to each pixel and its region before the photo's own Shadows.

// Re-baselined as the core tools move onto the stage path (#178), each time
// with the programs in program-reference.ts unchanged:
// - 2026-10-30, Effects: the six `*/meta` hashes, for Vignette's and Grain's
//   bindings from the frame's bag.
// - 2026-10-30, Color Grading: `*/uniforms`, `*/helpers` and `*/meta` (its
//   bindings and anchor), as its block moved from the template to its stage.
// - 2026-10-30, HSL: the same three per config, for applyHSL and its bands.
// - 2026-10-30, Tone Curve: the same three, for applyToneCurve and its table.
// - 2026-10-30, White Balance: `*/uniforms` and `*/meta`, for its sliders.
// - 2026-10-30, Basic and Sharpening: `*/uniforms` and `*/meta`, for their
//   sliders and anchors.
// - 2026-10-31, Effects left core (Phase 4): the six `*/meta` hashes, for
//   Vignette's and Grain's bindings under the Effects extension's stage ids.
// - 2026-10-31, Color Grading left core: the six `*/meta` hashes, for its
//   bindings under the Color Grading extension's stage id.
// - 2026-10-31, HSL left core: `*/uniforms` and `*/meta`, as its stage took
//   over uHslRange and uHslSmooth from the program and its id changed.
// - 2026-10-31, Tone Curve left core: the six `*/meta` hashes, for its table's
//   texture binding under the Tone Curve extension's stage id.
// - 2026-10-31, White Balance left core: the six `*/meta` hashes, for its two
//   sliders' bindings under the White Balance extension's stage id.
// - 2026-11-01, Basic left core: the six `*/meta` hashes, for its thirteen
//   sliders' bindings under the Basic extension's five stage ids.
// - 2026-11-01, Detail left core: the six `*/meta` hashes, for its four
//   sharpening sliders' bindings under the Detail extension's stage id.
// - 2026-11-01, Crop & Straighten left core: `*/uniforms`, `*/helpers` and
//   `*/meta`, for its geometry uniforms, cropTransformUV and their bindings.
// - 2026-11-01, Heal left core: `*/uniforms`, `*/helpers` and `*/meta`, for
//   its spot uniforms and constants, its helpers and their bindings.
// - 2026-11-01, Masking left core: `*/uniforms`, `*/helpers` and `*/meta`,
//   for its mask and component uniforms, compCoverage and their bindings.
// - 2026-11-03, Tone Curve range fix (Anthony approved range fixes on version
//   2 and later; version 1 frozen): the six `*/helpers` hashes. Lines 2 and 3
//   read the table at the clipped colour and add back what the clip took,
//   under SL_PROCESS_VERSION >= 2.
// - 2026-11-03, Shadows fix (Anthony approved making ±100 a smooth
//   continuation of ±50 on version 2 and later; version 1 frozen): the six
//   `*/helpers` and six `*/meta` hashes, for Basic's basicShadows helper,
//   which its tone block calls for the slider.
//
// From 2026-10-30 the assembled programs (the `*/shader/*` hashes) are frozen
// with every version's in program-reference.ts, which took them over while
// these still passed.

export const V2_REFERENCE: Readonly<Record<string, string>> = {
  "builtin/effects": "6039aff0794c47e3a45fcdee57dfcafe301ce1c9f06fd36d4f844422615789d5",
  "builtin/helpers": "55bf74ba49308ee87e334589bc0c7407b38a5d63b1c141c0237977726a156532",
  "builtin/meta": "0f54bb086d74155437d57e69c13e75a89083732a3fe316b1a45849f9656f0a00",
  "builtin/noiseReduction": "eef65e49a5de2300be39305d91aa23064dbd08364090027345a4ccf7113261a3",
  "builtin/sceneLinear": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "builtin/srcUv": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "builtin/uniforms": "d567f6382b6baedd5a2cb880f40d5ae8dd764f0b13f19e9b5c976aead119a6dc",
  "layered/effects": "6039aff0794c47e3a45fcdee57dfcafe301ce1c9f06fd36d4f844422615789d5",
  "layered/helpers": "55bf74ba49308ee87e334589bc0c7407b38a5d63b1c141c0237977726a156532",
  "layered/meta": "d6e0be1391a4cc0ffb35d0dc6030761fa19f32b7f4c4adfbd39a52032c32d69d",
  "layered/noiseReduction": "609911b73568fd5e28d594956b1e799d374018ddc337b4b82ca8f2a1deb1fffe",
  "layered/sceneLinear": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "layered/srcUv": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "layered/uniforms": "1975c3a97280bfe1d88051cbdbc086e8fd1d7975658adab06f50a03287cca877",
  "legacyExtensions/effects": "c04e12b8aace174150d0d78fa27f7bab7d042777c191c05027c419b873de3753",
  "legacyExtensions/helpers": "c42397d22e67a82efe36f13d1659c41d4128caa540d42374c0e1551db04217c6",
  "legacyExtensions/meta": "da4f0c9d1162bc60c8494578ebce889a3a23eb592a862ea32f18d4b2200cbdee",
  "legacyExtensions/noiseReduction": "ed6a9fc5191520336c0b703811bcae7117d3f5093ab55db6940162d6c99ff784",
  "legacyExtensions/sceneLinear": "8dbffc7a5b765c59116c415438cbfb600a99d0d49255ed2d928af732383310b6",
  "legacyExtensions/srcUv": "5e65c39113bf763c3c3ad5eecc1cbe34b202d939b2876d2800c25d85c2750bf5",
  "legacyExtensions/uniforms": "a3818e0295e86345e4c5f11c9bf80967fb4534fc83f5afdcf6295b5b3af6a1c6",
  "sceneLuma/effects": "d81c06c341905e950a23c9ec6f85be2e9c971a2795ff4ee36c898b73f5941778",
  "sceneLuma/helpers": "55bf74ba49308ee87e334589bc0c7407b38a5d63b1c141c0237977726a156532",
  "sceneLuma/meta": "b7569ea160b63ac6fe648a84283fe1e135195183aed172c04c3e0ca49d6b656b",
  "sceneLuma/noiseReduction": "eef65e49a5de2300be39305d91aa23064dbd08364090027345a4ccf7113261a3",
  "sceneLuma/sceneLinear": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "sceneLuma/srcUv": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "sceneLuma/uniforms": "0376c1be48d560d7ab609cdbbc6fb95e402bdffb87eb4e6a6cbf7aefcb0f2bfb",
  "spaced/effects": "1fc9966285706d38b2b3d6dd03d49b51feb6cac495a670c3615351fb9cc303b1",
  "spaced/helpers": "55bf74ba49308ee87e334589bc0c7407b38a5d63b1c141c0237977726a156532",
  "spaced/meta": "1b06b3fc38e01847ef637420847913e9dfafc5ed821dfa810f3896a4b8d492d3",
  "spaced/noiseReduction": "eef65e49a5de2300be39305d91aa23064dbd08364090027345a4ccf7113261a3",
  "spaced/sceneLinear": "60b28a243584743c6c534cbb4c8765070d878edae953c00987daf8e374ddc1b9",
  "spaced/srcUv": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "spaced/uniforms": "2a0f80e5adb11c995e4d980763278ba59769c5f5edb01140f7d273fac10c7135",
  "splits/effects": "58db012f651270c0649bc0999f84139b6ef5503f4140991bf9dbb776b97253be",
  "splits/helpers": "55bf74ba49308ee87e334589bc0c7407b38a5d63b1c141c0237977726a156532",
  "splits/meta": "44707119a9edbf61681d23646809ad3be31e21369ded7f7e66606ef74aae319d",
  "splits/noiseReduction": "eb150c7463d7ed266799e45b9bd42b9337ace137b4aa311fb1ba90661e364838",
  "splits/sceneLinear": "9f469ec2d54f78f2fac6fa6a543f84bf799dfd190301c453dac30c4989c0a502",
  "splits/srcUv": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "splits/uniforms": "47a8b5650577e934dff977a7846ade0069e96d366905b41de9fe0111b8c88b0e",
};
