// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A theme's window material (acrylic or mica): the system draws the window's
// backdrop and the page's translucent surfaces show it. Windows 11 22H2 and
// later use the background material, macOS uses vibrancy, and every other
// system keeps the opaque window. The last choice is saved so the next
// launch's first paint already has it.

const fs = require("node:fs");
const path = require("node:path");

const MATERIALS = ["acrylic", "mica"];
const WINDOWS_11_22H2 = 22621;
const MAC_VIBRANCY = { acrylic: "sidebar", mica: "under-window" };
// The colour a window shows before the page paints. A transparent one only
// takes where a material makes the window translucent; elsewhere its alpha is
// dropped and the launch would flash black.
const OPAQUE_BACKGROUND = "#1a1a1a";
const CLEAR_BACKGROUND = "#00000000";

/** @returns {"acrylic" | "mica" | null} */
function parseMaterial(value) {
  return MATERIALS.includes(value) ? value : null;
}

/** @param {{ platform: string, release: string }} system */
function canDraw({ platform, release }) {
  if (platform === "darwin") return true;
  if (platform !== "win32") return false;
  const build = Number(String(release).split(".")[2]);
  return build >= WINDOWS_11_22H2;
}

/** The material the window will really get: none in software rendering, where
 *  the compositor has no backdrop to show through. */
function effective(material, system) {
  return material && !system.software && canDraw(system) ? material : null;
}

/**
 * @param {{ setBackgroundMaterial?: (m: string) => void, setVibrancy?: (v: string | null) => void, setBackgroundColor?: (c: string) => void }} win
 * @param {"acrylic" | "mica" | null} material
 * @param {{ platform: string, release: string, software: boolean }} system
 * @returns {boolean} whether the window was asked to draw the material
 */
function applyMaterial(win, material, system) {
  if (!canDraw(system)) return false;
  const wanted = effective(material, system);
  try {
    if (system.platform === "darwin") {
      win.setVibrancy(wanted ? MAC_VIBRANCY[wanted] : null);
    } else {
      win.setBackgroundMaterial(wanted ?? "none");
    }
    win.setBackgroundColor(wanted ? CLEAR_BACKGROUND : OPAQUE_BACKGROUND);
    return wanted !== null;
  } catch {
    return false;
  }
}

/** BrowserWindow options for the first paint. */
function windowOptions(material, system) {
  const wanted = effective(material, system);
  if (!wanted) return { backgroundColor: OPAQUE_BACKGROUND };
  return system.platform === "darwin"
    ? { vibrancy: MAC_VIBRANCY[wanted], backgroundColor: CLEAR_BACKGROUND }
    : { backgroundMaterial: wanted, backgroundColor: CLEAR_BACKGROUND };
}

function readMaterial(file) {
  try {
    return parseMaterial(fs.readFileSync(file, "utf8").trim());
  } catch {
    return null;
  }
}

function writeMaterial(file, material) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, material ?? "", "utf8");
  } catch { /* non-fatal */ }
}

module.exports = { applyMaterial, parseMaterial, readMaterial, windowOptions, writeMaterial };
