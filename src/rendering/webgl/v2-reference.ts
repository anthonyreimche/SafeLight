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
// - 2026-11-08, exact pass reads (Anthony approved it for every version):
//   the six `*/meta` hashes, for the pass programs. A three-channel pass
//   starts every draw after its first from its own texel fetched exactly.
//   Every hardware backend tested already read it exactly; SwiftShader mixed
//   in a trace of the neighbours (pass-reads-exact.webgl.test.ts).
// - 2026-11-24: #287 Masking line 3 reads extension component rasters
//   (Anthony approved re-baselining version 2): the six `*/uniforms`,
//   `*/helpers` and `*/meta` hashes. Version 2 photos draw with the installed
//   Masking release, whose line 3 declares the uMaskRasters sampler and reads a
//   type 5 component from its channel, nothing while no raster is held.
//   Existing edits draw the same pixels.
//
// From 2026-10-30 the assembled programs (the `*/shader/*` hashes) are frozen
// with every version's in program-reference.ts, which took them over while
// these still passed.

export const V2_REFERENCE: Readonly<Record<string, string>> = {
  "builtin/effects": "6039aff0794c47e3a45fcdee57dfcafe301ce1c9f06fd36d4f844422615789d5",
  "builtin/helpers": "2e27100338cb1f9b68e8c5636ceaefd0e330815afae309cf94195ce31d679bbc",
  "builtin/meta": "4beb18af30ca689b1f342c0f2dd595b9792a9adaf96b7b2cb1a57130f339dde9",
  "builtin/noiseReduction": "eef65e49a5de2300be39305d91aa23064dbd08364090027345a4ccf7113261a3",
  "builtin/sceneLinear": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "builtin/srcUv": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "builtin/uniforms": "a623b703086d88af946d1377832fa96d0528b9ff088dacd49b0b1f694fb44bae",
  "layered/effects": "6039aff0794c47e3a45fcdee57dfcafe301ce1c9f06fd36d4f844422615789d5",
  "layered/helpers": "2e27100338cb1f9b68e8c5636ceaefd0e330815afae309cf94195ce31d679bbc",
  "layered/meta": "80bcfb88a4b203d7020f8ba98c55a89ad922b3dbc26f2c6e8e66f0429cb3d42a",
  "layered/noiseReduction": "609911b73568fd5e28d594956b1e799d374018ddc337b4b82ca8f2a1deb1fffe",
  "layered/sceneLinear": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "layered/srcUv": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "layered/uniforms": "c3f45fcf0673460def00e9f0e4638452cb34722104a7f87c69757bb73e7844c2",
  "legacyExtensions/effects": "c04e12b8aace174150d0d78fa27f7bab7d042777c191c05027c419b873de3753",
  "legacyExtensions/helpers": "82a99b2459f981b24b53eb03e0c04b96a425ccdf6fa483ff8bdefc394b899904",
  "legacyExtensions/meta": "bc4b827ebf7bc20f7469c7b08099ae4bc9b814a684f05933c56104644a5c60fb",
  "legacyExtensions/noiseReduction": "ed6a9fc5191520336c0b703811bcae7117d3f5093ab55db6940162d6c99ff784",
  "legacyExtensions/sceneLinear": "8dbffc7a5b765c59116c415438cbfb600a99d0d49255ed2d928af732383310b6",
  "legacyExtensions/srcUv": "5e65c39113bf763c3c3ad5eecc1cbe34b202d939b2876d2800c25d85c2750bf5",
  "legacyExtensions/uniforms": "7857d02d387c56c7053abb5017b9bc185ce708773ddcf221ec66c5070ff523e0",
  "sceneLuma/effects": "d81c06c341905e950a23c9ec6f85be2e9c971a2795ff4ee36c898b73f5941778",
  "sceneLuma/helpers": "2e27100338cb1f9b68e8c5636ceaefd0e330815afae309cf94195ce31d679bbc",
  "sceneLuma/meta": "396c28b7be30b77879c89e2a985c0fdfe7dd14ce10fd929b9cea23e7da8f6820",
  "sceneLuma/noiseReduction": "eef65e49a5de2300be39305d91aa23064dbd08364090027345a4ccf7113261a3",
  "sceneLuma/sceneLinear": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "sceneLuma/srcUv": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "sceneLuma/uniforms": "0ac57e02e73283dca38ac09bfd971f8ffad287ab0eef49d12a19b8babad535d5",
  "spaced/effects": "1fc9966285706d38b2b3d6dd03d49b51feb6cac495a670c3615351fb9cc303b1",
  "spaced/helpers": "2e27100338cb1f9b68e8c5636ceaefd0e330815afae309cf94195ce31d679bbc",
  "spaced/meta": "09375f70b088d20965a6498781991a8312d5041e98f3a8133cd223135d194678",
  "spaced/noiseReduction": "eef65e49a5de2300be39305d91aa23064dbd08364090027345a4ccf7113261a3",
  "spaced/sceneLinear": "60b28a243584743c6c534cbb4c8765070d878edae953c00987daf8e374ddc1b9",
  "spaced/srcUv": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "spaced/uniforms": "6d82f0877ab156a939eb7370ddd42cf53256f629e2e13db73c06664fa730c48c",
  "splits/effects": "58db012f651270c0649bc0999f84139b6ef5503f4140991bf9dbb776b97253be",
  "splits/helpers": "2e27100338cb1f9b68e8c5636ceaefd0e330815afae309cf94195ce31d679bbc",
  "splits/meta": "13db9d12c90402b20d74371bd34c05dd6726406c7e78e144df9a8f0dec19a8c2",
  "splits/noiseReduction": "eb150c7463d7ed266799e45b9bd42b9337ace137b4aa311fb1ba90661e364838",
  "splits/sceneLinear": "9f469ec2d54f78f2fac6fa6a543f84bf799dfd190301c453dac30c4989c0a502",
  "splits/srcUv": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "splits/uniforms": "1b5a91bfab775bd2d9382151070cd7aa25459f23168550e9d296b1aa5d58d0c9",
};
