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
  "v2/builtin/builtin": "87ed0e28379e2c253b6e0ac53494308495a0a707d4456126f0454d018f12c86e",
  "v2/builtin/custom": "03c62c229181a5ba70c3925b09512b482c5ffb766c4e04e10f3777fd9a7b370e",
  "v2/builtin/rec2020": "f03955360708be21c64bbdafc25a37a808a0fdabb7c0df647ea59dd377f209d0",
  "v2/layered/builtin": "15d32f04f28f3ba37b1db471883162c915388c3e601f3dd4e3c94e2052276525",
  "v2/layered/custom": "e0ccf82951091d8cf6fb2ebea9f5f8f1f114b28535a6f172dfcd336fb90d473e",
  "v2/layered/rec2020": "35f9074d7d60ee87d2b37f0a4d3dd086af06a0e62b662d283be16871f84539fd",
  "v2/legacyExtensions/builtin": "dc71ce8dab0e9d644e09ff9cccd766adda06b0570db83227ae9ce37fd93c2d31",
  "v2/legacyExtensions/custom": "b0e1fc0af1651932fb9add894efca05652820bb812268384040134b6c0da472d",
  "v2/legacyExtensions/rec2020": "d84756486b8bc61158920d25e2254155a834e24076f60d2ba4a0272fdd873847",
  "v2/sceneLuma/builtin": "cfcc97cb534927160b076a605b4272bbed28c95630582a664c3e14360e9d4d3a",
  "v2/sceneLuma/custom": "3eee45dd9f465d634bbe3cd1bc1fdf9f9a2d894c1a22c16a4d07b6ab10071f17",
  "v2/sceneLuma/rec2020": "81fcdbc8cb311a136ed2e5f31c630746a0c8ec50d8d4bb351587fb668a7e529d",
  "v2/spaced/builtin": "b6ef43c2c4deba496c8a55545f6450b4837bd490cfaea2672b190d98d5646284",
  "v2/spaced/custom": "dbbf2e9a7c5b83a6811d99a8a4b618a1bf3451fa9aeb9b425fd166d319ab3169",
  "v2/spaced/rec2020": "42243bcda2ab4716740c53db5401a1145b16f1a4d26344979a569bfd2f0a570a",
  "v2/splits/builtin": "55119e6ad4c2668ac76a0be39732cfe5b06104d74f2515d0fbc698169e37ff6c",
  "v2/splits/custom": "d4be0fceef66df483d2715b07f7997f1218b130082724018053beb9eaaa6dd1e",
  "v2/splits/rec2020": "b5cc1d35bbfb1400be60c59a8d29af87a8963f21ea58469c8e68c832840a8762",
  "v3/builtin/builtin": "f3e3914c92ce0fdb4f514f883cd6225c84f66f2e9b78211e2d31a9b894582465",
  "v3/builtin/custom": "a47713215a308f8d0c013c2e390c14cec8ffaadf773b3c08eb01723b40c04de4",
  "v3/builtin/rec2020": "e30a8d78e21df620f00046715bb9eac6b4d6ee972917e35cd5207bca754daa0b",
  "v3/layered/builtin": "afbb93a0720820664ad729b7a4ef5d741309f4d0fe81a53a5ae68b4f6ebc90b3",
  "v3/layered/custom": "293e47c2f10ffcbf5484b13f3d28b1958249e021d22c912207d4ab5721fb4310",
  "v3/layered/rec2020": "2da7316277b2f980ad23301a1a84376ee8a58c0db035740597292e28526b8e66",
  "v3/legacyExtensions/builtin": "6db120696f4fdd5a00af26495e36014577259400699cbcd3c46c20d64d8a3139",
  "v3/legacyExtensions/custom": "877daf60eb2fd71b8452c48d226db30e1172335aadd75448abda70e5607f11bc",
  "v3/legacyExtensions/rec2020": "186dd21503392bf6c119a8967353c207208827a34826cad7a869913bbd5e32ac",
  "v3/sceneLuma/builtin": "0f698e275cb8852dabb83dd4d4fdbf8d5a6373dfd15596911660dd624523657b",
  "v3/sceneLuma/custom": "a7ce20894bce701693c2b28cc8bcffd6b5bd98f6007cc5680432fe72ed1be448",
  "v3/sceneLuma/rec2020": "0b88940d47e99f5ea6eda90cf821358503ca03b3e754d084e49acd2cfc7c90bc",
  "v3/spaced/builtin": "68876588f8664ed29654471b75c163051393ab02e57a0e0fa723b94a09167001",
  "v3/spaced/custom": "54bff3f733f5cf4092dc26dd9bef942394946467a47f526baf664b677d49790c",
  "v3/spaced/rec2020": "bbc5f29cb668ae2cdc4933bf2f38d63a98029fc2acc326be20af3d4503a8feff",
  "v3/splits/builtin": "f1db97e8aa5b9653e23e705f202557dd9b3da2e79213bcebe940c0c793c1a052",
  "v3/splits/custom": "2d7643ec125e3868f2f92f261db50e2bd022f4301ad20e62017dffc020d3d30e",
  "v3/splits/rec2020": "63b69854f60ff374c8713d6a61c191e06563c5605ccb70c966f9f8414315976b",
};
