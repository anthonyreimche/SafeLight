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
  "v2/builtin/builtin": "1e90accdc30c07152dca65ca1c01626d303a3f689440528dc6665c867b464b61",
  "v2/builtin/custom": "0ee6b3787b51738c16eb88d032b67a9817555ac32cc8a4692339c6cd760a4a6d",
  "v2/builtin/rec2020": "79ae024d5c11a058853e77d9240bc62b7e7d352f78f153c4e768403784987089",
  "v2/layered/builtin": "6ed1d6ba91a3d5d7e8dbb3a81207a41549a312adfb623a751eaf0377afab80ab",
  "v2/layered/custom": "1cfad13ae294dd85609ef658982b633773e44549670062b707b2bdc62314d43c",
  "v2/layered/rec2020": "e31a1ae2b5dd77a9995134691c3e5649061837bb641bda29ad1ea5315ea6bbac",
  "v2/legacyExtensions/builtin": "a94ca999828c0f4ddefe3788eb3bcb98f8a2d5df37aee2697a6b739a539cb3da",
  "v2/legacyExtensions/custom": "8649ebebe4bc2f56785f31d5723e9c9670630175aac6e4c60cc2906e6678f970",
  "v2/legacyExtensions/rec2020": "b5e9bd3e58072daa03bb58fc05c6cc43da21acf0cc1187c7d23569b33498f59d",
  "v2/sceneLuma/builtin": "af175d4a093f3ab95071f82062ca8762972011b05963d881ef0f089de71249ac",
  "v2/sceneLuma/custom": "5b6bb8ca1b1085ccb2bfc45086df235ee1d606f144d06a5b1ffe6d2d284239a1",
  "v2/sceneLuma/rec2020": "600b98e9376fb195581188ce0c5e1b51dea88efa14c51f34d59f7297498b7b20",
  "v2/spaced/builtin": "32f299d8e7a641415b57fc7ab55df084a99c66e034c22396a44fdd4bfce07537",
  "v2/spaced/custom": "8bb62449de541d49fbd0b22f753ec71016ecd2dec7da3367b3d1b69c6a721fd2",
  "v2/spaced/rec2020": "5cb88f8580bf8b42ac9c1ad5108ba9b709ee17ae96329e02226eeb241c7bd985",
  "v2/splits/builtin": "a44b8cbc5970c072423d3d59afa31d0bf8f5a07241086c59dd617ed013aa7ad0",
  "v2/splits/custom": "d208d96c34f8175becb208306b9f6694ad071ac8ffaa04dbb05a11db8b9a23cb",
  "v2/splits/rec2020": "e16c31a1b821666b60c8d1d95732a398c576cb57bc2eceaa006ccb9ec4b3f1d8",
  "v3/builtin/builtin": "4f4c3ba7fe2c78314eb6cc4f72c147d427b68efaf7f3cb57b7a3082acb70bb5c",
  "v3/builtin/custom": "5a79468444dd2981c847370427838cd4870a8c67c273b1b13c3d643a10b7a021",
  "v3/builtin/rec2020": "0e87a08718d85f25595716782f0c9d59e24da0300ddaed3f3b9f1acfff4e0791",
  "v3/layered/builtin": "3622dc7088b7c9ee70ceaf2e69fc550c95c83d77a3e159922add4e63cbe1a32b",
  "v3/layered/custom": "c24e17ca8db2382578a68be924a662bc3056363c1591fdd5cccb4e0e333ff405",
  "v3/layered/rec2020": "1be199c7d672d629b69c6d2074f1e12c60aa7438bc90c13867cc7121a4373f26",
  "v3/legacyExtensions/builtin": "7e7991b557198adc171715da9af7a65297265e9712ea565efba55dae9953fb6f",
  "v3/legacyExtensions/custom": "f1b46632fb524f4065704b832a06033533cbeb637ae04f8c906af112f4d5f40d",
  "v3/legacyExtensions/rec2020": "5326d208861456cd465679d7aa094a66550a10cdf1b3fb63f8e9c4d68c0ddd8d",
  "v3/sceneLuma/builtin": "801cefea833dff946ba9fb70331548a9bf556f076dec82d20a11b88edd864baf",
  "v3/sceneLuma/custom": "6e0ee295309219a04869b8d16b86fb903001afa458b3cad7cfa748e36149c8bf",
  "v3/sceneLuma/rec2020": "5bfed7633ec483b1b641d711922da8233287443d7d40e6aae39b5a003e7f3022",
  "v3/spaced/builtin": "cfc77d472598f43283ac6ae6b76d4577d8130ee1812fb32105c9f657cdac84d1",
  "v3/spaced/custom": "ac913ea2f1bde83932e916ea080d12b9d60348ab235dc114c321568118511818",
  "v3/spaced/rec2020": "863ab412eaf5b1e63a030275b43d9f708d4e39629f1c6e562745a240722b2599",
  "v3/splits/builtin": "0ea691b51e10b0b0559f1da9d021c4fbdcf0cc3cd5ce92661004013045696a88",
  "v3/splits/custom": "15d47b8e4cb11ce0e3844c53b07a64af59699af3f7258ed03492a503684e804f",
  "v3/splits/rec2020": "19351e6921ece39a9c6fff325a1348a2065de5d0895b1cbaaca1efc01b77c169",
};
