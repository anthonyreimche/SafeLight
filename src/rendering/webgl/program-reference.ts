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

export const PROGRAM_REFERENCE: Readonly<Record<string, string>> = {
  "v1/builtin/builtin": "35e80eeeab1a1bb210afb006964087815329e4c002be69ae412630f9c837ad3b",
  "v1/builtin/custom": "ef30393e7f8bbfb6f146136ce2c87d5633568a692dbdde43aa36b3127664ad99",
  "v1/builtin/rec2020": "81e189c97771a04a336a724c4c1c146ceb6155ff45e4a287e5ff5f78a2159ff2",
  "v1/layered/builtin": "268abf44feab3648cff15d82b2258a821709a541982e2c1aac2fbef8d6903b20",
  "v1/layered/custom": "0a6c04c94ee2e193e108e538cbb03825a40ffe55a795e502b650a4e05db47cbb",
  "v1/layered/rec2020": "10e2e3370b4f28455146b11e55d5269f74411d1472cc8d659192e0485702b4e3",
  "v1/legacyExtensions/builtin": "1616ea6ab442fab7486ec54d720289a9128122450fa0f199f53da472994ab0cf",
  "v1/legacyExtensions/custom": "d7310fee4f240328274f8e76ebcd1f756c68cad452e956173dddca53c970b01e",
  "v1/legacyExtensions/rec2020": "2b2fe73df66e0de04807ffb50e9ff6e7b2495dac0d7b97727b9f9374db937a33",
  "v1/sceneLuma/builtin": "69d892442282d867a8f0106e58b66f527e85e4eed6cd315b044a830aa751595b",
  "v1/sceneLuma/custom": "a2302dd4c8b51ddabc2bd23a00177d9dd840de80145fbb87ec8eeeaa451b07bc",
  "v1/sceneLuma/rec2020": "642e70a8615d7277b0c70a11907f038c09ae561b29d4973fbaacc206d4045169",
  "v1/spaced/builtin": "d358e9ccdd5865db78f8bb681ab1ce437b77036c3af2bd1c062166cc92933dc9",
  "v1/spaced/custom": "f030b872674e2240e19f5b6bb117392054c9a79a77ff96f30d3b3639883c3a0e",
  "v1/spaced/rec2020": "b2cdb05c5f3a44d7eb88d7fbc5c02b93a555cb8bd69ff2161df6492b1b3c3194",
  "v1/splits/builtin": "cd6204cf5400f40d0a43c684e1c3c85b0825a66181423b9ef21ddf33d0710d60",
  "v1/splits/custom": "a51b20e81dab5df65cc03414daf86d79056ac87982b89997e29a4e1d4309aa79",
  "v1/splits/rec2020": "682e73e56fe27b623177c641d72d2d39785fdcb9f11ab6aca171cfc20096db65",
  "v2/builtin/builtin": "2358febc8bc5bf47d282090f962c34fc01e16dc5475dffc5f967711ecfdd07c5",
  "v2/builtin/custom": "186c3e3c20f72421d8bb78a8689cfee77ebfa83d9941bedb2a500286dc733f31",
  "v2/builtin/rec2020": "d7919932e4feb085e927ef08261bc79dee398afad70888c25e90a7d543c6e26e",
  "v2/layered/builtin": "5a1178eaf74154d97b021c9e5c2707bf5ad7898c8b8c95112e555f5b114702f9",
  "v2/layered/custom": "56d0cbffca8a7d918d41072fa224123229c3d8d305e3eeebd52fa886cac3324d",
  "v2/layered/rec2020": "3c3e2af6f0073ad2cd5e7f96599b43b03d419fa461cbd36d72b90416c22c2b09",
  "v2/legacyExtensions/builtin": "43a921324abe0db7b828a71d3ac437ed2df4f139132a5e78ebd89104f2fa194a",
  "v2/legacyExtensions/custom": "34811f43e9a107fb8454e5f76f324d54cac5de9c5ff728c91479371ad0a2a37f",
  "v2/legacyExtensions/rec2020": "a3aaa39a1b59f07c782c8e69b6fb79141814f74e7d9436eccf7f70b9de6af101",
  "v2/sceneLuma/builtin": "103dd0461d63f4f2e8e378f213a71df56b1c6c8f6adf2a7aea0d81884d5a3a4f",
  "v2/sceneLuma/custom": "f3ba384aa889f64921a35f82ef07b9b0d0eca03fbd834bd9377d97a9bc267fff",
  "v2/sceneLuma/rec2020": "d2e9892218022fc438ffadcf7ac5a337ab30e476d2b0ff9440c0b13871ab19ab",
  "v2/spaced/builtin": "de9100e73521d97cdd055c9407f5b222e0b026bb2eac19b49f9391f6fa6d39b1",
  "v2/spaced/custom": "f33bd354b0adbbcf2ad60d58f4749036efd50c738e7e273783380ddceb9852b7",
  "v2/spaced/rec2020": "4cdc369a83a785496ff6fc271c4c142b18949e9e79f86260c7a05660af67e33b",
  "v2/splits/builtin": "5877a056904052cb357d93edd468b6a39c21e394df81c9427800a21011267d32",
  "v2/splits/custom": "1eaa24b219781aefd491acc3badba23ef6a796544b142461c7323d79108ac5dc",
  "v2/splits/rec2020": "388b2a8f4e5322648402b3a034fefc9de1a2489aa469d09afe0f9ae8066ce7fd",
  "v3/builtin/builtin": "6e674ba3386678c449639c57bf723ed701b42dc985a687d5cbebdf55fe4bfd7c",
  "v3/builtin/custom": "18abc1a77090d2cccabc56a0564af43a06ed147c315f2af3c6f731537b2bde8a",
  "v3/builtin/rec2020": "78ace661dcc524c0941f550e8aefc99213b780fbefbc3e84bc150d69205036cd",
  "v3/layered/builtin": "b66a2ba74f7742390ee7c55c21ca5ee9300d579f670bec29a0a5e745ea34aadd",
  "v3/layered/custom": "28b73f7a2ff1368c953b112abe4a9a885fc190193d9392348687f0438005bb0c",
  "v3/layered/rec2020": "0ed6667472d2cd222da6bff0c7bf07c3c63c29e407742cb9f235bc89911db814",
  "v3/legacyExtensions/builtin": "1710e5f03bb0c1254fb84eb4eff6102d7c077eec81e3b429e302e89109000fef",
  "v3/legacyExtensions/custom": "c4a7fa83f77a7615413627592e5082eaadaca36116c0bcdf58600d6e6e1a2c7b",
  "v3/legacyExtensions/rec2020": "aa0738feeb617a285acf1fff3d68ea0898bf356148a726ed86a586a6a7ce8d68",
  "v3/sceneLuma/builtin": "17fe7c3b795207da4925ea27156a650481d7782bb4c9807c2b35b678a4d1ed66",
  "v3/sceneLuma/custom": "e9a49a0d3a6f1e21bdee0a55bd245c7d50dfdf7fb18e6b6f5641444fad1136ff",
  "v3/sceneLuma/rec2020": "b4fad80a56df6c1d25dbc43b6f84fb8d06eb794b869c4b682590ff04f83bee32",
  "v3/spaced/builtin": "769f9fad4799f9c15514c30b932e3bd754ebab919103c78461ef8802f7706e3e",
  "v3/spaced/custom": "cfce362755673444405b86b100ae1e66965b549c53feb468d87953ca518872e6",
  "v3/spaced/rec2020": "9d0574745cff77bbcf245a35d1853e9826efc1fc48f972412cbd8d6e4c886475",
  "v3/splits/builtin": "337d39291f009ee17e252169d0484c730d6356551176df6f7eed4bf62405a764",
  "v3/splits/custom": "123d870f032e5ea86ff0552adb93298cf6023608455d0b73de042be8e02e9794",
  "v3/splits/rec2020": "84396eebc3e7485421e689d2306625cf6accdab2d317633c97c19fdb5b388708",
};
