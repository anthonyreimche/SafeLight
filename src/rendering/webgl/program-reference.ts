// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The whole develop program of every process version, frozen: SHA-256 of
// canonicalGlsl (program-identity.fixtures.ts) for each fixture config and
// display transform, keyed `version/config/pipeline`. Taken on 2026-10-30,
// before any core tool's GLSL moved onto the stage path, from programs the
// version 1 test (b1f5ec5's literal shader) and the version 2 hashes
// (v2-reference.ts) both still passed; it replaces their whole-program checks,
// which compared top-level declarations in order. Version 3 had no text freeze
// before this.
//
// Edited on purpose on 2026-11-03: Anthony approved range fixes on version 2
// and later, version 1 frozen. Tone Curve lines 2 and 3 read the table at the
// clipped colour and add back what the clip took, which changed every v2 and
// v3 hash; the v1 hashes are untouched.
//
// Edited again on 2026-11-03, the same 36 hashes (Anthony approved fixing
// Tint on version 2 and later, version 1 frozen): applyWhiteBalance scales its
// gains so a grey keeps its luminance (`gain /= luma(gain);`), unity at the
// as-shot point. The v1 hashes are untouched.
//
// Edited again on 2026-11-03, the same 36 hashes (Anthony approved making
// Shadows ±100 a smooth continuation of ±50 on version 2 and later, version 1
// frozen): Basic's tone block runs the slider through its basicShadows
// helper, whose gain in stops grows in step with the slider and fades out
// below mid grey, under SL_PROCESS_VERSION >= 2. The v1 hashes are untouched.
//
// Edited again on 2026-11-03, the same 36 hashes (Anthony approved the mask
// Temp/Tint luminance fix and mask Shadows matching Basic's on version 2 and
// later, version 1 frozen): applyMaskLinear scales its Temp/Tint gains so a
// grey keeps its luminance, and its Shadows runs slShadows (local-tone.ts, the
// twin of basicShadows). The v1 hashes are untouched.
//
// Edited again on 2026-11-06, all 54 hashes, version 1 included (Anthony
// approved the fix for every version): main() also paints the outside colour
// where the point is outside the photo before the contributed geometry stages
// warp it (sensorUv), so a stage that zooms in, as a lens correction's auto
// crop does, no longer draws the photo into crop mode's margin. b1f5ec5's
// literal (v1-reference-shader.ts) carries the same edit.
//
// Edited again on 2026-11-11, the same 36 hashes (2026-11-11: detail gain
// block (Dynamic detail), approved by Anthony, version 1 frozen): versions 2
// and 3 declare uDetail where version 1 declares the unused uDevelopedSrc,
// with uDetailOn, uDetailRect and uDetailAmount, and scale `lin` by the gain
// after the core noise-reduction block while uDetailOn is set. The v1 hashes
// are untouched.
//
// Edited again on 2026-11-22, the same 36 hashes (Anthony approved keeping
// a RAW's camera exposure under display transforms that drop the baseline,
// version 1 frozen): main() and slLocalToneTap apply uBaselineGain outside
// the uApplyBaseCurve gate, and the renderer sends 1 for anything but a RAW.
// Under the built-in transform the pixels are unchanged; under one that sets
// skipBaseCurve a RAW now arrives at its camera match's exposure. The v1
// hashes are untouched.

export const PROGRAM_REFERENCE: Readonly<Record<string, string>> = {
  "v1/builtin/builtin": "3f1f81f7c98881be54232b4523a8a60ee1d247e99c6b87a8045284d6bcc590d3",
  "v1/builtin/custom": "d10bcd5f9c0e8f266ce08c45a2d5eb64f5051a9b3cd4970fed768bdfdb12cf91",
  "v1/builtin/rec2020": "a91c4d4b0f19e4b3cfed57662911f1ba67cd86ce883263bd9e9b557cff757b8c",
  "v1/layered/builtin": "e97ea33f0ebc77a3e338993e0fdbbc3bb082371b9599a1047242f453a40e85e1",
  "v1/layered/custom": "f343b1e92129732f2927fc35293a28b30cc559b599feb494c26323f71fb2b546",
  "v1/layered/rec2020": "a6930dc2c6cb3db696682c1a91ead78d0c3e0964d5ec70da18a3cace582f9e88",
  "v1/legacyExtensions/builtin": "82d2b095681889c826b7c33e85743401ed9da7ab96c765a990b9af7594eac3b3",
  "v1/legacyExtensions/custom": "a292b77a651928e329054ffcc992efb2c6a6c189fe71e8cd800673b064ae64ff",
  "v1/legacyExtensions/rec2020": "e21f068b30e9ec06bb0ca8eeeafa15c06c37fae59f202e875bc3184a8b4d9950",
  "v1/sceneLuma/builtin": "074c114a40c3992b1b868df7a19375f24c2d92d9f1631bc1f992c86db35bcbfc",
  "v1/sceneLuma/custom": "8a3b3d75f97e1af735b7a24a27de1d19234d15ed1860b9c27228cc5d74b3c15a",
  "v1/sceneLuma/rec2020": "f1a22bccd6e91daf1a73304d3683c24d4dddae38d89f9598dd6282a9148e01f6",
  "v1/spaced/builtin": "8df29ebf738528d92a6322be772ecf6c329f712adc914294ee1da5831378ee5a",
  "v1/spaced/custom": "5ba7488df016e8a7fd6869f613662bfedb8ed1f9ff7ce69c3b7ac623e9176559",
  "v1/spaced/rec2020": "b4e2328ccd92fcbf9867937d4f37360f199b8f7a0cc629c58b136e8c10a8ce27",
  "v1/splits/builtin": "d9f869312a1c66e307803fe06744306daaa21da47cc68940229492062383e852",
  "v1/splits/custom": "61c414aed48a7b6c71d0a0382b205c151cacc73cd3b8ca14716dacfcecda68c6",
  "v1/splits/rec2020": "6153c3ae0ee6aa3ec9b116afc684ae2735da3aef23c7916a4fdbdfffaf8318c3",
  "v2/builtin/builtin": "53c1f71e2a2254e2083c0c8e02fdc391d0351b68a301b310e268c44677be9e43",
  "v2/builtin/custom": "9a29c6367c6a0e33450879be603fafbbf4deecb151908225fb06052ae884bbb4",
  "v2/builtin/rec2020": "75c90c2a0d92c8d8da5c99e96c105f74b1d01aa1a0e90aa6ca2063e2e2185955",
  "v2/layered/builtin": "e0628fb56c083cbdf7b2309311783242e3edf9ca76295a80324a4f7865dfb90d",
  "v2/layered/custom": "2de56d74d25531d087e59a6ae90d86214d32fc441f05951a3c4b52b53a5a66e5",
  "v2/layered/rec2020": "81e1d8c2278535a7306ddad93a20294b374cfa473210e474a8f8349131833faf",
  "v2/legacyExtensions/builtin": "bb62998296661b66587d214a020bd0427cab1ce829ddb4a7e440e5b4118ff25b",
  "v2/legacyExtensions/custom": "d106fc39e160e319148a5568c96535fe8ce797d8235d18ccfc29d0953d397171",
  "v2/legacyExtensions/rec2020": "0a83e7a8a165d81e7def1653ad24457fc83fefefeb7a1cd47862588b01a4576a",
  "v2/sceneLuma/builtin": "3955e150611adb892c16e1dc6dcd864db546572da01d42b74bd6557b44c4ec95",
  "v2/sceneLuma/custom": "9ee6cc36001d6f1cf7fbc910d4fbd2d81ef0977d6a6e88c9ceaeb97133542dc9",
  "v2/sceneLuma/rec2020": "b55f4cd628f89c77cc489eddff0c8707b05ff5eb8ec4b186de4c9984561fb15b",
  "v2/spaced/builtin": "dff57778577b8945c7e6eb197a337c44a0346b7c951a54da6022f3e795ff693c",
  "v2/spaced/custom": "0936aa11730fcf8c417f3e2bc34ba0840e7708677fa669dd2e56dcb197e6d571",
  "v2/spaced/rec2020": "4cdd98d18222e6d006ddd7b235e0a0e3ee2d3a5a2fe658d0253cf774796de465",
  "v2/splits/builtin": "226a31604fb6d542c81e854246699c122cb879eb799ea8093fccfdca1cfc9267",
  "v2/splits/custom": "1fb6d9d372065f7f71833cd2ea1bf3ce46e3522fb9dda2da84b576eb3f625cef",
  "v2/splits/rec2020": "22ac61ac0dcb0fa91348316c7236444aed41fd5dc438b72577035b25f99c6186",
  "v3/builtin/builtin": "d0abb54605c461b08eb1db439d90ca024237f5371a46c95b295d9930fc1e4bd2",
  "v3/builtin/custom": "a2438118c22cdaf0172ef5cce8ed6a14520cf6b758512186de35a5a4c564016e",
  "v3/builtin/rec2020": "cdd37a77b772ca3427927e806db5a0dc38cb4eacccadf5425c3bbbe430355712",
  "v3/layered/builtin": "33c795bbb781c5f725ee4f1a0c6354928491a66ee2c897bf3cf027d024e051f2",
  "v3/layered/custom": "dba13827152413e32d7c58cbc4b6caac669222fe5cb9213c4a388928617e44b5",
  "v3/layered/rec2020": "87ce087a78fc49ad0a7d01b28d7b2e8485d25e9db883757b51d48dcb51bb41d7",
  "v3/legacyExtensions/builtin": "6cac25789997bae3276ce389483955a180a92f8293871aaf6bf6ac0b99a18f28",
  "v3/legacyExtensions/custom": "32c2d68d61ba4fa264834a7f53bbb5e68a32d6fa581acccdc8e0b7bea5876dff",
  "v3/legacyExtensions/rec2020": "5dbc68dae4dd89df9b16f76febc7b9a24249433b6f0b6fd80999b192f2f36299",
  "v3/sceneLuma/builtin": "9c62bba1ed31ea1bca121ac532722874c3c8cba10d4a07f1d29adf327cfaad64",
  "v3/sceneLuma/custom": "2010b71950b000cc1a992cc14100a7bff03be40dc4f8441cf43c4bdbe5ddc99e",
  "v3/sceneLuma/rec2020": "d45bae08d221b646c77f421bb9f5c4644bc972bc802a268690d9504c3da7c0ec",
  "v3/spaced/builtin": "809215f2bb1568345fad51ab2e37cb07043d9ffa859ee03994a850e01fb53660",
  "v3/spaced/custom": "279067de182c7d36a7d34bdbe149455e23501419d2a1dc2a0a6bc4a3601d066f",
  "v3/spaced/rec2020": "9dae916f9d2635089dd4af68a06923f3702dedeb18d4cc6aaaa19b6b6700db1c",
  "v3/splits/builtin": "56bc986aa39543e25709137ea725e9f0bdb246f88a9f9aab30e88ac3f0a42376",
  "v3/splits/custom": "3aedc7b617079ca8f4c2685c2cebd11d3ea63695fc8f50830eb5be8c7d140660",
  "v3/splits/rec2020": "db3c23591c1a9aa5c451bca83158623a9f4a74e96fb8aaa4c1ec04490f0df46b",
};
