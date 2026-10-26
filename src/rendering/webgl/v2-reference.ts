// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Process version 2, frozen: SHA-256 of each normalized piece Safelight 3.0.1
// built for the fixtures in v2-identity.fixtures.ts. Run v2Snapshot() on the
// commit that adds this file for the text behind a hash; normalizeGlsl and the
// snapshot format are part of the freeze too.
//
// Edited once, on purpose: on 2026-10-26 Anthony moved the camera baseline
// (baseline-tone.ts) into version 2 so every RAW gets it, existing edits
// included. That changed the 18 `*/shader/*` hashes; the stage injections,
// their metadata and the pass programs stayed as 3.0.1 built them.

export const V2_REFERENCE: Readonly<Record<string, string>> = {
  "builtin/effects": "6039aff0794c47e3a45fcdee57dfcafe301ce1c9f06fd36d4f844422615789d5",
  "builtin/helpers": "8dcbd66ab5f26c9d1d944ead85b6014c3e789ea89a04521d451af6e40404448d",
  "builtin/meta": "310fdb2ce9eb5865b81f1acf0dbe7e090b01d90db03fe5d9d0bf848b6a536ad9",
  "builtin/noiseReduction": "eef65e49a5de2300be39305d91aa23064dbd08364090027345a4ccf7113261a3",
  "builtin/sceneLinear": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "builtin/shader/builtin": "f70990a70637fec5044508e58285ea2346e9ed511aaa2596ab71fb98a9af1f13",
  "builtin/shader/custom": "785a00d2c67fc08b93ad02ef6b6ec2a790610cbaa2fb500d712d796e3104e2c2",
  "builtin/shader/rec2020": "e228777c3928b427b325fd30f8cb82da2a8d1de3c8eeba1d7ffc0a03905e6881",
  "builtin/srcUv": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "builtin/uniforms": "963f2e5c47dcd11d937e8a8c3677f11c2ca9fa4bcd8819c33ab5c7d81a07372b",
  "layered/effects": "6039aff0794c47e3a45fcdee57dfcafe301ce1c9f06fd36d4f844422615789d5",
  "layered/helpers": "8dcbd66ab5f26c9d1d944ead85b6014c3e789ea89a04521d451af6e40404448d",
  "layered/meta": "a1098359b8c6bc72166804afa984864780dc11a421dbc5be1102135d3a79c3c6",
  "layered/noiseReduction": "609911b73568fd5e28d594956b1e799d374018ddc337b4b82ca8f2a1deb1fffe",
  "layered/sceneLinear": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "layered/shader/builtin": "89c59cd6bb07c6cde93f81a525f53f4115023507c47dd5d954568528ec2d68d5",
  "layered/shader/custom": "2a0554970424317eb34f4e94d036b88fee56b10328b79ecd7cd29df9c2851a48",
  "layered/shader/rec2020": "61b1dee75d71aa449627dc48210b20afab33edbee3f7f6362381f322f8b9cd33",
  "layered/srcUv": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "layered/uniforms": "b7a6ce8d58ae742412e85a985ca5131f7baf39745a3533838acece34c232ae8a",
  "legacyExtensions/effects": "c04e12b8aace174150d0d78fa27f7bab7d042777c191c05027c419b873de3753",
  "legacyExtensions/helpers": "bddbc707f779b26e33fa0829d60de08f63a1cc47c7910a596b4d1f596abd5760",
  "legacyExtensions/meta": "8043617941009d276738bc60b8fc944e2b6379599f2bd32f9fa26c030f5797ed",
  "legacyExtensions/noiseReduction": "ed6a9fc5191520336c0b703811bcae7117d3f5093ab55db6940162d6c99ff784",
  "legacyExtensions/sceneLinear": "8dbffc7a5b765c59116c415438cbfb600a99d0d49255ed2d928af732383310b6",
  "legacyExtensions/shader/builtin": "a698fcbdbf5131afe2f57eb75063f031f6fb94aebe4246d65d3c789179909111",
  "legacyExtensions/shader/custom": "dec73626268cb7536cccd480abd2d588cfd2f1550c3bd9f6d230bbca475261b6",
  "legacyExtensions/shader/rec2020": "89523f4afd97a3e1774a9712a1a8f01ed9bd7a839affb41ed5eccc75a713d9d3",
  "legacyExtensions/srcUv": "5e65c39113bf763c3c3ad5eecc1cbe34b202d939b2876d2800c25d85c2750bf5",
  "legacyExtensions/uniforms": "58df837a027b3ac12d15f2437700a19a162f32ee8f59d8d268d0aaba13ad9c95",
  "sceneLuma/effects": "d81c06c341905e950a23c9ec6f85be2e9c971a2795ff4ee36c898b73f5941778",
  "sceneLuma/helpers": "8dcbd66ab5f26c9d1d944ead85b6014c3e789ea89a04521d451af6e40404448d",
  "sceneLuma/meta": "995db2ec1f007777ae7d7df1e25b3bf973c583982d0eeecf02d1e710e5f3e471",
  "sceneLuma/noiseReduction": "eef65e49a5de2300be39305d91aa23064dbd08364090027345a4ccf7113261a3",
  "sceneLuma/sceneLinear": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "sceneLuma/shader/builtin": "28335ccfbbcd172904ef7ae3c98a4eb335a816705c05694e0356dd994f63b020",
  "sceneLuma/shader/custom": "73d85a0848b22ae3bfbc32a9e35cceeb20c3bf4d1f771934fc68dd459a0822a1",
  "sceneLuma/shader/rec2020": "002925b95510eb0d3c77c66ed1e493eac2c2a3f34588d4ab31290089d2e06b9d",
  "sceneLuma/srcUv": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "sceneLuma/uniforms": "540724077a43b52d6a61bd1e4c603ac7f405eedcdc43f6c50b15beb5fe9dc242",
  "spaced/effects": "1fc9966285706d38b2b3d6dd03d49b51feb6cac495a670c3615351fb9cc303b1",
  "spaced/helpers": "8dcbd66ab5f26c9d1d944ead85b6014c3e789ea89a04521d451af6e40404448d",
  "spaced/meta": "99fc9e35de955e21402b11bb3d04cd039b1b6f4ba47c4a0e96aa48989e46ef08",
  "spaced/noiseReduction": "eef65e49a5de2300be39305d91aa23064dbd08364090027345a4ccf7113261a3",
  "spaced/sceneLinear": "60b28a243584743c6c534cbb4c8765070d878edae953c00987daf8e374ddc1b9",
  "spaced/shader/builtin": "aae08bdcb1407552f90a47028676a10350b5c17bf5c9c5b3b15a69a0d4a218ba",
  "spaced/shader/custom": "ca5e3eb9288dc411c8b810d6f2a15331a77f9c09c075b98144ad83aad80d2857",
  "spaced/shader/rec2020": "1c40d176a4bd1ae0af7effe50d512d9a1b81a224c015d1e3adc9020d57cb5098",
  "spaced/srcUv": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "spaced/uniforms": "d6d2f4daa56b2c8c8b6b2259380319c9b055356b9b419a4e700f31599fae18c3",
  "splits/effects": "58db012f651270c0649bc0999f84139b6ef5503f4140991bf9dbb776b97253be",
  "splits/helpers": "8dcbd66ab5f26c9d1d944ead85b6014c3e789ea89a04521d451af6e40404448d",
  "splits/meta": "e56ec8f41ac6c90d14fa6459eb498d0378b485f6b1bcf7c092de93601a2b89e0",
  "splits/noiseReduction": "eb150c7463d7ed266799e45b9bd42b9337ace137b4aa311fb1ba90661e364838",
  "splits/sceneLinear": "9f469ec2d54f78f2fac6fa6a543f84bf799dfd190301c453dac30c4989c0a502",
  "splits/shader/builtin": "84e6dcd30579e389430d83737ae1df9972d2962d5ff944df2ef0e6e0b3535f24",
  "splits/shader/custom": "2f7847b74ec584a2bbbdb90505d3696e7159dc63739af6f6025bb4d8a1fd0d09",
  "splits/shader/rec2020": "2bb0fe55ab28f3451910f11d9ddbce107694c2941e78fa7935a984693f2a0f6b",
  "splits/srcUv": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "splits/uniforms": "c206fd988ec12052c2b61ba707d3447699ca97f62b95273198f927996b67f2e5",
};
