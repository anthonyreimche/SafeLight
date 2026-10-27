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

export const V2_REFERENCE: Readonly<Record<string, string>> = {
  "builtin/effects": "6039aff0794c47e3a45fcdee57dfcafe301ce1c9f06fd36d4f844422615789d5",
  "builtin/helpers": "8dcbd66ab5f26c9d1d944ead85b6014c3e789ea89a04521d451af6e40404448d",
  "builtin/meta": "310fdb2ce9eb5865b81f1acf0dbe7e090b01d90db03fe5d9d0bf848b6a536ad9",
  "builtin/noiseReduction": "eef65e49a5de2300be39305d91aa23064dbd08364090027345a4ccf7113261a3",
  "builtin/sceneLinear": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "builtin/shader/builtin": "2683974498c6572604c5d2228c1f59e891e78d1af57b78f9c29f2779081735c4",
  "builtin/shader/custom": "8344f4a4854a84c44096b2c0dcf769e83158169d9c2f540162945042f3bfe46f",
  "builtin/shader/rec2020": "b5fd69b38cffa5b18e2220ecd3e19211713908e0fc5cf8cb3d326ad06baf4c8f",
  "builtin/srcUv": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "builtin/uniforms": "963f2e5c47dcd11d937e8a8c3677f11c2ca9fa4bcd8819c33ab5c7d81a07372b",
  "layered/effects": "6039aff0794c47e3a45fcdee57dfcafe301ce1c9f06fd36d4f844422615789d5",
  "layered/helpers": "8dcbd66ab5f26c9d1d944ead85b6014c3e789ea89a04521d451af6e40404448d",
  "layered/meta": "a1098359b8c6bc72166804afa984864780dc11a421dbc5be1102135d3a79c3c6",
  "layered/noiseReduction": "609911b73568fd5e28d594956b1e799d374018ddc337b4b82ca8f2a1deb1fffe",
  "layered/sceneLinear": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "layered/shader/builtin": "882d56be3fa66e13e4b8c37ebd3ab4cbcf92b3576c3c0302d17709052f27d81d",
  "layered/shader/custom": "98e19d7f3317a8ee09930229f2d77d4c86c428ab3a1e6f9e2a0dd0b6fd8444ca",
  "layered/shader/rec2020": "44803b275699f04e243c453bedeb8d1c0d67897535f7532157467013ce2dcfa3",
  "layered/srcUv": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "layered/uniforms": "b7a6ce8d58ae742412e85a985ca5131f7baf39745a3533838acece34c232ae8a",
  "legacyExtensions/effects": "c04e12b8aace174150d0d78fa27f7bab7d042777c191c05027c419b873de3753",
  "legacyExtensions/helpers": "bddbc707f779b26e33fa0829d60de08f63a1cc47c7910a596b4d1f596abd5760",
  "legacyExtensions/meta": "8043617941009d276738bc60b8fc944e2b6379599f2bd32f9fa26c030f5797ed",
  "legacyExtensions/noiseReduction": "ed6a9fc5191520336c0b703811bcae7117d3f5093ab55db6940162d6c99ff784",
  "legacyExtensions/sceneLinear": "8dbffc7a5b765c59116c415438cbfb600a99d0d49255ed2d928af732383310b6",
  "legacyExtensions/shader/builtin": "9ab26cdc56db587579334a31d7345fd66e9803c26ff82e9eaa194814fc5aa063",
  "legacyExtensions/shader/custom": "a92a1c0a24629510aff6c97cb93d9bfe662dafde4729fb3d1788e2042ca562b2",
  "legacyExtensions/shader/rec2020": "06b5939ad75eda0cc587ce42b44a1dd08de3992782068214a9a42700ab96e169",
  "legacyExtensions/srcUv": "5e65c39113bf763c3c3ad5eecc1cbe34b202d939b2876d2800c25d85c2750bf5",
  "legacyExtensions/uniforms": "58df837a027b3ac12d15f2437700a19a162f32ee8f59d8d268d0aaba13ad9c95",
  "sceneLuma/effects": "d81c06c341905e950a23c9ec6f85be2e9c971a2795ff4ee36c898b73f5941778",
  "sceneLuma/helpers": "8dcbd66ab5f26c9d1d944ead85b6014c3e789ea89a04521d451af6e40404448d",
  "sceneLuma/meta": "995db2ec1f007777ae7d7df1e25b3bf973c583982d0eeecf02d1e710e5f3e471",
  "sceneLuma/noiseReduction": "eef65e49a5de2300be39305d91aa23064dbd08364090027345a4ccf7113261a3",
  "sceneLuma/sceneLinear": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "sceneLuma/shader/builtin": "b81423d090e0c025b215e89faed0b310633273bd685a44aeccbbda4d699cfb6e",
  "sceneLuma/shader/custom": "207ff8ddae1a16954dcd046952e2e61a01db24de307142e0075e62d74cba93db",
  "sceneLuma/shader/rec2020": "d0e36f08ea24fd53e9f78e0aa77cf1a76b60fda555611671380f497813a7bcd1",
  "sceneLuma/srcUv": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "sceneLuma/uniforms": "540724077a43b52d6a61bd1e4c603ac7f405eedcdc43f6c50b15beb5fe9dc242",
  "spaced/effects": "1fc9966285706d38b2b3d6dd03d49b51feb6cac495a670c3615351fb9cc303b1",
  "spaced/helpers": "8dcbd66ab5f26c9d1d944ead85b6014c3e789ea89a04521d451af6e40404448d",
  "spaced/meta": "99fc9e35de955e21402b11bb3d04cd039b1b6f4ba47c4a0e96aa48989e46ef08",
  "spaced/noiseReduction": "eef65e49a5de2300be39305d91aa23064dbd08364090027345a4ccf7113261a3",
  "spaced/sceneLinear": "60b28a243584743c6c534cbb4c8765070d878edae953c00987daf8e374ddc1b9",
  "spaced/shader/builtin": "f06a1984e45fe9c5eedbe1298764272e81918ccdb93983142e45cb96ef51f9d0",
  "spaced/shader/custom": "63c3bf0a04b36eff12dfc6edfb92fd21788a00219d6cd07edfa0bac2a4dbed34",
  "spaced/shader/rec2020": "ca3be113ced024959b8c6e4af7a564b3ec04228e043871ba51512287d08ca604",
  "spaced/srcUv": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "spaced/uniforms": "d6d2f4daa56b2c8c8b6b2259380319c9b055356b9b419a4e700f31599fae18c3",
  "splits/effects": "58db012f651270c0649bc0999f84139b6ef5503f4140991bf9dbb776b97253be",
  "splits/helpers": "8dcbd66ab5f26c9d1d944ead85b6014c3e789ea89a04521d451af6e40404448d",
  "splits/meta": "e56ec8f41ac6c90d14fa6459eb498d0378b485f6b1bcf7c092de93601a2b89e0",
  "splits/noiseReduction": "eb150c7463d7ed266799e45b9bd42b9337ace137b4aa311fb1ba90661e364838",
  "splits/sceneLinear": "9f469ec2d54f78f2fac6fa6a543f84bf799dfd190301c453dac30c4989c0a502",
  "splits/shader/builtin": "4a5f76be0f993194ffc8c3250d5d48337d0f7d6b9d4e256820e95eb9d3e10706",
  "splits/shader/custom": "bcc78872838c5d259d5e934dce0c1ccfdc47b6d09045fda970442c325f4c6436",
  "splits/shader/rec2020": "515e5f8c55567111e35e63b8f5f14928f84963fe5ac6e93a3411ba16dcac19fa",
  "splits/srcUv": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "splits/uniforms": "c206fd988ec12052c2b61ba707d3447699ca97f62b95273198f927996b67f2e5",
};
