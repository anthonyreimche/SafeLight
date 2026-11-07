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
  "v2/builtin/builtin": "f95129d7bdf6de86cf7835b79b1cf44d38cb688a027014a0812ecbde81f86f98",
  "v2/builtin/custom": "6974781808e46a75b8e7ef2a7e9717ca39a2f86534e5300da1868c0b431eebd7",
  "v2/builtin/rec2020": "b55d05edc8c15f9c4411f0863373e4bf39989b735234e7f2a9008da4f586fd5a",
  "v2/layered/builtin": "1ad6b44b25eac3741ceac82edbad638f5c2286f17d6b4fc489ac11c966738eff",
  "v2/layered/custom": "e1a450e7e9e78066267f001fde717f8f863077d807628a53aae6127ae60861fb",
  "v2/layered/rec2020": "5b01776dea578bc6bb82ae969d609fb670cc92b2d07abf6bc218eaf0113c4fab",
  "v2/legacyExtensions/builtin": "d8d4d068d1441bc47ca7b5774d6bb13fa819be34b71f9d2ced5e1c74d07cd7d9",
  "v2/legacyExtensions/custom": "864e960e42df18334ceda46d5c4ee217ec06370b991fb626accac6349670a92e",
  "v2/legacyExtensions/rec2020": "f12717c55caf0a873abee410efc8c79e81be79f236dcfe71acf5a8182b1d5559",
  "v2/sceneLuma/builtin": "5f27c7378e77882a999898880fd958540a898ebf4becc597e8a6f18113897321",
  "v2/sceneLuma/custom": "03325e0bd2f690e5ebbd76fafc3eb3c8f758c85795a399e4c5e1a99a2424a0df",
  "v2/sceneLuma/rec2020": "b87a734764ca2754bd9c2b53e04276fd84cb599a1af11368e4f3d4a3ebee30e3",
  "v2/spaced/builtin": "ad62da24f93798ea2d3eeb87b6f1ca947a66e2f1d32ba3013c3ceac0003b8a84",
  "v2/spaced/custom": "9321c50cef392e3357dd4aeb1152fad407ef8a333c562f48f49a3b43552912bc",
  "v2/spaced/rec2020": "5922a680f440c4c3f3b9b5b1135dffe72e35accc3dd087c44eac1ad2da2fb691",
  "v2/splits/builtin": "52e715212105a13e236dddb86384007606151a8a5bc5a010f36a4e7e25a60a99",
  "v2/splits/custom": "7f0d9e776ffb4591112d5dfd9a7e26e9db7f373158db0c36ce2c6a024e0d9538",
  "v2/splits/rec2020": "47145f56e13634befba2fd8964caa0cdd0bc013b555fb0fa78b78caf2d3b8541",
  "v3/builtin/builtin": "5a87088dcabcfa539c4799f37a216a0ad882bc3bf91aba837e0dcd4d39157afc",
  "v3/builtin/custom": "cb2e0b8be014536b4fdf05cf24e4939b57a4f4f1eace3c63b478945593ad7898",
  "v3/builtin/rec2020": "12b1e722924d2bbdb256e99e9fcbfbc54f8fc5d1ba9252f59352494c65688501",
  "v3/layered/builtin": "fddd4a554c62c3f641cd0fa6eff55df4aec3551c0a989841c451608511089bb5",
  "v3/layered/custom": "d45541376b7cef06e39a330c4db58cad9f9e6c06439291040266d83106eb1bd3",
  "v3/layered/rec2020": "624affe13d727c2410c3884be63dc5cd98fda1af26bb90b7179eb98ffce0650b",
  "v3/legacyExtensions/builtin": "841b9e54482b9ecc2995ae7bb95243380eab6a5390574e71d26f6935f405d2ac",
  "v3/legacyExtensions/custom": "cb99edf05a3295a9b44a33f47ec8c8e72d0e4455096a0520c9ff79b34bba65c4",
  "v3/legacyExtensions/rec2020": "9003893beb7df459c146779899d460b0a4485634aa69cd9e7fd8ba3c726fa176",
  "v3/sceneLuma/builtin": "a81199d822a7875915b9315b048cda1bd506335a65e78777127e358813ff7ad0",
  "v3/sceneLuma/custom": "1ccdf34cef300973710c4836493ccb3e96a8a0061ee71cc37fb8da7166ca4064",
  "v3/sceneLuma/rec2020": "cfd829f5e7ba61a299d7f62fd689ccb6336a7e7f7f49900664812d0ab92bf276",
  "v3/spaced/builtin": "e6005439552d2f7a1a0420cb9bf829f1bf589d747c89b38e9127e378b8560a96",
  "v3/spaced/custom": "7bbb1ebff405d557a034c6ec6bee891e4e622bf5da461ba3a1128b69db5fd1a2",
  "v3/spaced/rec2020": "0e703527dd67a2d3da4efe2349bc13f221d80a5c5cf9ceef43f6ffc26ab8110d",
  "v3/splits/builtin": "716ea040e0d9145880425d5f09105b3d52ae682383ab0d59f54a69c0fa94ac9e",
  "v3/splits/custom": "51d0b33e48b83284d35f4f66478be4ed95012a440b7ed6c941cb9a3c758a4773",
  "v3/splits/rec2020": "b285d687134773c59529add7542c6c19e348bb4994beaf2c4ea49045960be0ec",
};
