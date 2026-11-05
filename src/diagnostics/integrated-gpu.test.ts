// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Preferences ▸ Performance suggests the integrated graphics settings when the
// WebGL renderer string names graphics that share the processor's memory, or
// software rendering. It names the device the way the user knows it, without
// ANGLE's wrapper or the driver details.

import { describe, expect, it } from "vitest";
import { integratedGpuLead, integratedGpuName } from "./integrated-gpu";

describe("integratedGpuName", () => {
  it.each([
    ["ANGLE (AMD, AMD Radeon 760M Graphics (radeonsi phoenix ACO), OpenGL ES 3.2)", "AMD Radeon 760M Graphics"],
    ["ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", "AMD Radeon(TM) Graphics"],
    ["ANGLE (AMD, AMD Radeon Vega 8 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", "AMD Radeon Vega 8 Graphics"],
    ["ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)", "Intel(R) UHD Graphics 620"],
    ["ANGLE (Intel, Mesa Intel(R) Iris(R) Xe Graphics (TGL GT2), OpenGL 4.6)", "Mesa Intel(R) Iris(R) Xe Graphics"],
    ["ANGLE (Intel, Intel(R) Arc(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", "Intel(R) Arc(TM) Graphics"],
    ["ANGLE (Qualcomm, Qualcomm(R) Adreno(TM) X1-85 GPU Direct3D11 vs_5_0 ps_5_0, D3D11)", "Qualcomm(R) Adreno(TM) X1-85 GPU"],
    ["ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)", "Software rendering"],
    ["llvmpipe (LLVM 17.0.6, 256 bits)", "Software rendering"],
    ["ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)", "Software rendering"],
    ["ANGLE (AMD, AMD Radeon(TM) RX Vega 10 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", "AMD Radeon(TM) RX Vega 10 Graphics"],
    ["ANGLE (AMD, AMD Radeon R7 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", "AMD Radeon R7 Graphics"],
    ["ANGLE (Intel Inc., ANGLE Metal Renderer: Intel(R) Iris(TM) Plus Graphics 655, Unspecified Version)", "Intel(R) Iris(TM) Plus Graphics 655"],
    ["ANGLE (Intel, Vulkan 1.3.255 (Intel(R) UHD Graphics 630 (0x00003E92)), Intel open-source Mesa driver)", "Intel(R) UHD Graphics 630"],
  ])("names %s", (renderer, name) => {
    expect(integratedGpuName(renderer)).toBe(name);
  });

  it.each([
    "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti (0x00002782) Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (AMD, AMD Radeon RX 7600M XT Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (AMD, AMD Radeon RX 6800 XT (radeonsi navi21 ACO), OpenGL ES 3.2)",
    "ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)",
    "ANGLE (AMD, AMD Radeon R9 380 Series Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (AMD, AMD Radeon HD 7900 Series Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (AMD, AMD Radeon VII Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (Intel, Intel(R) Arc(TM) Pro A60 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (Intel, Intel(R) Iris(R) Xe MAX Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "",
  ])("leaves %s alone", (renderer) => {
    expect(integratedGpuName(renderer)).toBeNull();
  });
});

describe("integratedGpuLead", () => {
  it("opens the hint with the device, software, or nothing found", () => {
    expect(integratedGpuLead("AMD Radeon 760M Graphics")).toBe("AMD Radeon 760M Graphics shares memory with the processor. ");
    expect(integratedGpuLead("Software rendering")).toBe("This computer draws without its graphics card. ");
    expect(integratedGpuLead(null)).toBe("For graphics that share memory with the processor. ");
  });
});
