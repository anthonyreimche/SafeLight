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
  "v2/builtin/builtin": "ccbfa99dac48a7edb0e703ccb1fae024bf24c7eed8992ade74f092b8a67bab47",
  "v2/builtin/custom": "8a0d2e744e72857049990d7ff3e628bf530a71f539f2f78646d42c4af6e9a370",
  "v2/builtin/rec2020": "6e388e82b85882a5ec2e572a0b43f0dd66c22371db797097c8d63e43bc90a6d2",
  "v2/layered/builtin": "659f83b7eb599e9832afd0378e9c98d816c30082e211c91b3c99569fd2c0c387",
  "v2/layered/custom": "1718f49e3a612cdb7561512f5d9bbece649179f425ee66cbd97ba9a55781ab86",
  "v2/layered/rec2020": "83b6563f86d0d55b27f963d26732d012e000d68208d113abbd01ae186150e4d0",
  "v2/legacyExtensions/builtin": "4e270c510cf44598da54238c2cbfb039e091875369981e365a101a1a249c17ea",
  "v2/legacyExtensions/custom": "eb85554906abd893c039ad475106d7bd8200f64dbc119f52d7be401f0c547aa5",
  "v2/legacyExtensions/rec2020": "26014797239407a48365e47249400937aedbdcd18887cb7ea46c3317a7fd086e",
  "v2/sceneLuma/builtin": "e781b221ddb544684cf3092e333960524ad50b96de800abc73e1c739c59f8831",
  "v2/sceneLuma/custom": "4cb57ae886d0f60913506470ea5bf4b01dcf38f489abfc83f75274b9e0229b7e",
  "v2/sceneLuma/rec2020": "23566fa7e4f42fa5e8a86d2a85ed54dd9b641911005a5178c8861558d4dcac90",
  "v2/spaced/builtin": "a296ac5120651b2420469dd6da35c03c3a3134be3f6af99689c81a5cbeafab39",
  "v2/spaced/custom": "a287a43b4c578c2f4a0a1c1d2711e2f7d4dc01e0583caa7b3ba9702e38a29db3",
  "v2/spaced/rec2020": "028dcad3fb4b6843f0c4dd00347bda852bbce891760b050b7e1d36ad53f4d0d5",
  "v2/splits/builtin": "0fdaac8b91b6d995c8e3543e0885173d2018951feafa750e115aad9632515662",
  "v2/splits/custom": "4a97e478ec70f9e53e37de654e13a46182c600e2a211747587ca7b9123c91295",
  "v2/splits/rec2020": "aa6528b70758ac8ec83e7a605fed26803a633ad957de4365418adee406a4660b",
  "v3/builtin/builtin": "5b06fe0c926c60173f867106df13c4dad76edf2b25aa5ee8a4fe075aa070a863",
  "v3/builtin/custom": "15754d8a9213861013c94b075959255f74cbcb04bbfdc8f47613fe2438db7ac6",
  "v3/builtin/rec2020": "c0aeac1adffd49b91f7790f41dd8572217864f8d8a8930c4558f67ba966e6dcc",
  "v3/layered/builtin": "a3dc18ff765000eaa339aa2a0c4fb708584271a4f545ea80cd50aa3bc9587ecb",
  "v3/layered/custom": "87fc14f7a7b3151cb0839deeb253b4aadd49ab330da009a1244042a44f1c4a4f",
  "v3/layered/rec2020": "928c44e8c39abd040f4c6879dcf27929c18264910851709eb5511fb1c4a3e78f",
  "v3/legacyExtensions/builtin": "aacc4cd980f14cb94f590ae92c9bc1c7816c23670751e7f61a34c25a22cae031",
  "v3/legacyExtensions/custom": "307f2f3bf90ece5951526e2fa1d1358c70a03098a6d59a2410fdf4e16d0acf39",
  "v3/legacyExtensions/rec2020": "b3132766bfd5aece60c13fc80269e42e894f30a10a80c95363f1eb2a430fd2f1",
  "v3/sceneLuma/builtin": "355f32115bab0bdabcdf673e7a13c27028f990640b07ffeafdc8956d011f1ad7",
  "v3/sceneLuma/custom": "92ea400eaf8fc6476a3c51f22dd730dda147e6b84512568aecaf3c89526d6616",
  "v3/sceneLuma/rec2020": "2960d746506496ec6379b770ad9854e1aa310d566d04c2bc43124570ba6163e8",
  "v3/spaced/builtin": "8f16af23516079ba6f794ea083a4912dbf9cdbaeaccccc4294b3fc270e9dff97",
  "v3/spaced/custom": "67bd7f3b79b54936733366493a394e8e011ffca051445deb671e8941b03de364",
  "v3/spaced/rec2020": "703eb94a469fe8268647990b1a5d86d9c551d10125ce3b69954989ced4b5cdfc",
  "v3/splits/builtin": "d29259e1a1a9ed18fb24fab6f4806233a4aba771598c54234dc14fee0a5f408b",
  "v3/splits/custom": "a8066100c9800d4e6fd5403404cdbe00d0b94667f7f4f4d1c2f7fb3568f73a55",
  "v3/splits/rec2020": "de64e5ceda1b2a1144f96147a6f4c12b8bde664cdbfdefe1d2b6ec170ff43271",
};
