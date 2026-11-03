// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Integrated graphics share the processor's memory and bandwidth, so the
// full-size float targets Develop renders through cost them far more than a
// card with its own memory. Apple's M-series also share memory but have the
// bandwidth for it, so they are left alone.

const SOFTWARE = "Software rendering";

// ANGLE wraps the device as "ANGLE (Vendor, Device, API)". Inside it, Metal
// prefixes "ANGLE Metal Renderer: ", Vulkan wraps the device as "Vulkan x.y
// (Device (0xID))", D3D11 appends the shader model, and Mesa a parenthesised
// driver/chip note.
function deviceName(renderer: string): string {
  const angle = /^ANGLE \([^,]*, (.*), [^,]*\)$/.exec(renderer);
  let device = angle ? angle[1] : renderer;
  device = device.replace(/^ANGLE Metal Renderer: /, "");
  const vulkan = /^Vulkan [\d.]+ \((.*)\)$/.exec(device);
  if (vulkan) device = vulkan[1];
  return device
    .replace(/ Direct3D\d+.*$/, "")
    .replace(/ \((?:0x[0-9A-Fa-f]+|[^()]*(?:ACO|GT\d|LLVM)[^()]*)\)$/, "")
    .trim();
}

// AMD's integrated parts end in "Graphics" ("Radeon 760M Graphics", "Radeon(TM)
// Graphics", "RX Vega 10 Graphics", "R7 Graphics"); its cards don't ("RX 7600M
// XT", "R9 380 Series", "HD 7900 Series", "VII").
const amdIntegrated = (device: string): boolean =>
  /Radeon/i.test(device) && /Graphics$/i.test(device) && !/\bPro\b/i.test(device);

// Intel's cards are Arc A- and B-series (Pro included) and the Iris Xe MAX.
const intelIntegrated = (device: string): boolean =>
  /Intel/i.test(device) && !/Arc\S*(?: Pro)? [AB]\d{2,3}/i.test(device) && !/Xe MAX/i.test(device);

/** The device's name when `renderer` (WEBGL_debug_renderer_info) is
 *  integrated graphics, "Software rendering" for a software rasteriser, and
 *  null for a graphics card with its own memory or a string it can't place. */
export function integratedGpuName(renderer: string): string | null {
  if (/SwiftShader|llvmpipe|softpipe|Basic Render Driver/i.test(renderer)) return SOFTWARE;
  const device = deviceName(renderer);
  if (/Apple|NVIDIA|GeForce/i.test(device)) return null;
  const mobile = /Adreno|Mali|PowerVR/i.test(device);
  return amdIntegrated(device) || intelIntegrated(device) || mobile ? device : null;
}

/** The first sentence of the integrated graphics hint, for what
 *  integratedGpuName found. */
export function integratedGpuLead(found: string | null): string {
  if (found === SOFTWARE) return "This computer draws without its graphics card. ";
  if (found) return `${found} shares memory with the processor. `;
  return "For graphics that share memory with the processor. ";
}
