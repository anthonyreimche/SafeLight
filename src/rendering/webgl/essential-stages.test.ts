// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Core's copies of the Essentials' stages hold the text each extension ships.
// The extension's own tests pin its text with these same hashes: a change on
// either side fails one of them until both agree again.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { essentialStages, stageText, type EssentialLine } from "./essential-stages.fixtures";

const ESSENTIAL_LINE_HASHES: Record<EssentialLine, Record<string, string>> = {
  1: {
    "safelight.crop.geometry": "8b75ed903282d975542d751c938d58afdd762ce26463af4ab2f48ada743acc31",
    "safelight.heal.retouch": "747ee2bf13ec1faaefaf6369283678f1bbcd97ef8de2bfe69c43b1ce6d671767",
    "safelight.masks.coverage": "19474e2690a267a8dd81dbc3a248c6831f990c9673629fb9842cb27368d92fbc",
    "safelight.white-balance.balance": "3d219c7b3496d44c42b88403910030e33bb3ce40aaab9411e1846d661ae4c998",
    "safelight.basic.tone": "8316be94955ac1f25e7875f283e965dcb857f54ddd196306500da046a01ab3cc",
    "safelight.basic.display": "91163eb2d10b465f8c76a8fe40081a1540de67b3e7b067a886d89511b6cfa7b0",
    "safelight.basic.presence": "8f7db9f9e3cd683989903680719342546e7eb4fcbe8aba75f9dfdd7fc87f89d9",
    "safelight.basic.band-detail": "576e32d19abe101364b52da39bad192ee9f7e0b550dca589d54f47362ad102e5",
    "safelight.basic.vibrance": "b52d15afa88ae6efc86ff41434e377b72194a25a58f585344bd8d5d8b5f9a130",
    "safelight.tone-curve.curve": "08fe7f3021f135193e885c5e352722c697401e2755e075b93c476718a8495863",
    "safelight.color-grading.grade": "fe57ac4e2f95c76228f7c8b2dc34522000a507b29693c0f24cafc7461270c088",
    "safelight.hsl.mix": "e228a29720f17db7a9c6699b9c538c7ab0b8552f63067651fb901c56b702fcca",
    "safelight.detail.sharpen": "329aff2fafaab25f86cd516e50ffc1c228c55759ab1e6171843403ee192ee161",
    "safelight.effects.vignette": "3dac62ade9e612267b496672e91a2a10fb035fb8b8a23ee224e96b0b5ed58c4e",
    "safelight.effects.grain": "5ad32488fe7a3c56debf686b8c4ef9fcbb72c6de097a326280487eca05f42419",
  },
  2: {
    "safelight.crop.geometry": "8b75ed903282d975542d751c938d58afdd762ce26463af4ab2f48ada743acc31",
    "safelight.heal.retouch": "7d48e923e283d2a22f084c7fe42009bf25c480a880d8cc977bac37849782b8a7",
    "safelight.masks.coverage": "84c45658aa749f02ef686b98dda4249aed77bce8383c9763d3b712f462d15667",
    "safelight.white-balance.balance": "3d219c7b3496d44c42b88403910030e33bb3ce40aaab9411e1846d661ae4c998",
    "safelight.basic.tone": "4cf1078f5558c4a8d4b79bf882a4d426f4f54f6f34ee992f8c6997baa6c1584a",
    "safelight.basic.display": "ca8456a68e6aa294d080ad64520030d43aee56755992c98421ec34648140de3f",
    "safelight.basic.presence": "01d11d693d9c73571d91f51a15fc3fb2ca210501000fe7911c3c8250fd837164",
    "safelight.basic.band-detail": "242979eb84fe05b84865c0f7c77dfb09f5e1e6d8bacc5d744465cf06570cd868",
    "safelight.basic.vibrance": "458c125417ef905ad4dcb84633a412d0d1fb594881cba9024a85c66ef2109ba9",
    "safelight.tone-curve.curve": "e0e565669513c7ad8e0eed360bad2e453ce20785f486b6e63c783e466ecd2203",
    "safelight.color-grading.grade": "cd8629296f5c91ae176fc11b0da2ff5e43854680124613dfabba0a6e0b5bceec",
    "safelight.hsl.mix": "3389038c079d541875c2a95a0d756a854633bb7ced64c2e8cbe68062da5d2df5",
    "safelight.detail.sharpen": "329aff2fafaab25f86cd516e50ffc1c228c55759ab1e6171843403ee192ee161",
    "safelight.effects.vignette": "51287cbbb0984543d83de81a324ed495b868ddefa277401569cbc262902ffd26",
    "safelight.effects.grain": "9e68fbd0ff683b1620a397a8554fc9a1cd6def243c3f4de6e71a1d86fef07518",
  },
  3: {
    "safelight.crop.geometry": "8b75ed903282d975542d751c938d58afdd762ce26463af4ab2f48ada743acc31",
    "safelight.heal.retouch": "7d48e923e283d2a22f084c7fe42009bf25c480a880d8cc977bac37849782b8a7",
    "safelight.masks.coverage": "84c45658aa749f02ef686b98dda4249aed77bce8383c9763d3b712f462d15667",
    "safelight.white-balance.balance": "3d219c7b3496d44c42b88403910030e33bb3ce40aaab9411e1846d661ae4c998",
    "safelight.basic.tone": "4cf1078f5558c4a8d4b79bf882a4d426f4f54f6f34ee992f8c6997baa6c1584a",
    "safelight.basic.display": "ca8456a68e6aa294d080ad64520030d43aee56755992c98421ec34648140de3f",
    "safelight.basic.presence": "01d11d693d9c73571d91f51a15fc3fb2ca210501000fe7911c3c8250fd837164",
    "safelight.basic.band-detail": "242979eb84fe05b84865c0f7c77dfb09f5e1e6d8bacc5d744465cf06570cd868",
    "safelight.basic.vibrance": "458c125417ef905ad4dcb84633a412d0d1fb594881cba9024a85c66ef2109ba9",
    "safelight.tone-curve.curve": "e0e565669513c7ad8e0eed360bad2e453ce20785f486b6e63c783e466ecd2203",
    "safelight.color-grading.grade": "cd8629296f5c91ae176fc11b0da2ff5e43854680124613dfabba0a6e0b5bceec",
    "safelight.hsl.mix": "3389038c079d541875c2a95a0d756a854633bb7ced64c2e8cbe68062da5d2df5",
    "safelight.detail.sharpen": "329aff2fafaab25f86cd516e50ffc1c228c55759ab1e6171843403ee192ee161",
    "safelight.effects.vignette": "51287cbbb0984543d83de81a324ed495b868ddefa277401569cbc262902ffd26",
    "safelight.effects.grain": "9e68fbd0ff683b1620a397a8554fc9a1cd6def243c3f4de6e71a1d86fef07518",
  },
};

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

describe("the Essentials' stage copies", () => {
  it.each([1, 2, 3] as const)("hold line %i as the extensions ship it", (line) => {
    const got = Object.fromEntries(essentialStages(line).map((s) => [s.id, sha256(stageText(s))]));
    expect(got).toEqual(ESSENTIAL_LINE_HASHES[line]);
  });

  it("are registered by official extensions", () => {
    for (const s of essentialStages()) expect(s.extensionId).toMatch(/^safelight\./);
  });
});
