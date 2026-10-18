// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Builds every logo asset from the two masters exported from art/icon.ai:
// safelight-stamp.svg (the round badge) gives the favicons and the app icon;
// safelight-logo.svg (the sticker) gives the landing site logo, the README
// banner, the social preview and the installer header. The installer sidebar's
// card titles are set in Afacad Bold (SIL OFL 1.1, source/Afacad-Bold.ttf).
// From the repo root:
//
//   npm i --no-save opentype.js
//   node art/logo/build-logo.cjs
//
// The rules it encodes are written up in art/logo/README.md.

const fs = require("node:fs");
const path = require("node:path");
const opentype = require("opentype.js");
const sharp = require("sharp");

const LOGO = __dirname;
const ROOT = path.join(LOGO, "..", "..");
const DARKROOM = "#0f0b0b";
// The landing site's print palette (site/index.html), used by the installer art.
const PRINT = { paper: "#f3ece0", card: "#fbf8f2", ink: "#16110f", muted: "#5c514b", red: "#e5172f" };

const STAMP = fs.readFileSync(path.join(LOGO, "safelight-stamp.svg"), "utf8");
const STICKER = fs.readFileSync(path.join(LOGO, "safelight-logo.svg"), "utf8");

const font = opentype.loadSync(path.join(LOGO, "source", "Afacad-Bold.ttf"));
const UPM = font.unitsPerEm;
const round = (n) => Math.round(n * 100) / 100;

function contours(glyph) {
  const out = [];
  for (const c of glyph.path.commands) {
    if (c.type === "M") out.push([]);
    out[out.length - 1].push(c);
  }
  return out;
}

// Font units (y up) at pen position `penX` to SVG path data (y down) in px.
function pathData(commands, penX, scale) {
  const X = (x) => round((penX + x) * scale);
  const Y = (y) => round(-y * scale);
  return commands
    .map((c) => {
      if (c.type === "M") return `M${X(c.x)} ${Y(c.y)}`;
      if (c.type === "L") return `L${X(c.x)} ${Y(c.y)}`;
      if (c.type === "Q") return `Q${X(c.x1)} ${Y(c.y1)} ${X(c.x)} ${Y(c.y)}`;
      if (c.type === "C") return `C${X(c.x1)} ${Y(c.y1)} ${X(c.x2)} ${Y(c.y2)} ${X(c.x)} ${Y(c.y)}`;
      return "Z";
    })
    .join("");
}

const svg = (viewBox, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>\n`;

/** The master's drawing: everything inside its root <svg>. */
function inner(master) {
  return master.slice(master.indexOf(">", master.indexOf("<svg")) + 1, master.lastIndexOf("</svg>")).trim();
}

/**
 * The painted extent of a master in its own units, from its alpha rendered at
 * 8x, widened to the next half unit. Measured on a canvas padded past the
 * viewBox, so art that overruns its artboard is measured, not cut.
 */
async function inkBox(master) {
  const k = 8;
  const pad = 64;
  const [vx, vy, vw, vh] = /viewBox="([^"]+)"/.exec(master)[1].trim().split(/[\s,]+/).map(Number);
  const padded = master.replace(/viewBox="[^"]+"/, `viewBox="${vx - pad} ${vy - pad} ${vw + 2 * pad} ${vh + 2 * pad}"`);
  const { data, info } = await sharp(Buffer.from(padded), { density: 72 * k })
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  let [x1, y1, x2, y2] = [info.width, info.height, -1, -1];
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[y * info.width + x] === 0) continue;
      x1 = Math.min(x1, x);
      x2 = Math.max(x2, x);
      y1 = Math.min(y1, y);
      y2 = Math.max(y2, y);
    }
  }
  if (x1 === 0 || y1 === 0 || x2 === info.width - 1 || y2 === info.height - 1) {
    throw new Error(`master paints more than ${pad} units past its viewBox`);
  }
  const floor = (n, origin) => Math.floor((n / k) * 2) / 2 + origin - pad;
  const ceil = (n, origin) => Math.ceil((n / k) * 2) / 2 + origin - pad;
  const box = { x: floor(x1, vx), y: floor(y1, vy), x2: ceil(x2 + 1, vx), y2: ceil(y2 + 1, vy) };
  return { x: box.x, y: box.y, w: box.x2 - box.x, h: box.y2 - box.y };
}

/** The master cropped to `box`, as its own file. */
const cropped = (master, box) => svg(`${box.x} ${box.y} ${box.w} ${box.h}`, inner(master));

/** The master's `box` drawn `h` units tall with its top-left at x, y. */
function embed(master, box, x, y, h) {
  const w = (box.w * h) / box.h;
  return (
    `<svg x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" ` +
    `viewBox="${box.x} ${box.y} ${box.w} ${box.h}">${inner(master)}</svg>`
  );
}

/** The master's `box` drawn `h` units tall, centred on a `width` x `height` canvas. */
const embedCentred = (master, box, width, height, h) =>
  embed(master, box, (width - (box.w * h) / box.h) / 2, (height - h) / 2, h);

// Capitals in Afacad Bold at `size` px with `tracking` em between letters,
// outlined; baseline at y = 0.
function setCaps(text, size, tracking) {
  const scale = size / UPM;
  let pen = 0;
  let d = "";
  for (const glyph of font.stringToGlyphs(text)) {
    for (const p of contours(glyph)) d += pathData(p, pen, scale);
    pen += glyph.advanceWidth + tracking * UPM;
  }
  return d;
}

// The histogram card's two channels, copied from site/index.html.
const HISTOGRAM_FILL =
  "M0 92 L0 82 L3 81.9 L6 81.9 L9 81.7 L12 81.4 L15 81 L18 80.1 L21 78.8 L24 76.9 L27 74 L30 70.2 L33 65.3 L36 59.4 L39 52.8 L42 46.1 L45 39.8 L48 34.6 L51 31.2 L54 30 L57 31.1 L60 34.4 L63 39.5 L66 45.6 L69 52.1 L72 58.1 L75 63.3 L78 67.1 L81 69.5 L84 70.3 L87 69.6 L90 67.5 L93 64.1 L96 59.6 L99 54.2 L102 48.2 L105 41.8 L108 35.5 L111 29.6 L114 24.6 L117 20.8 L120 18.6 L123 18 L126 19.3 L129 22.2 L132 26.5 L135 31.9 L138 38 L141 44.5 L144 50.8 L147 56.8 L150 62.2 L153 66.9 L156 70.8 L159 73.9 L162 76.3 L165 78.1 L168 79.4 L171 80.3 L174 80.9 L177 81.4 L180 81.6 L180 92Z";
const HISTOGRAM_LINE =
  "M0 92 L3 91.9 L6 91.9 L9 91.7 L12 91.4 L15 91 L18 90.1 L21 88.8 L24 86.9 L27 84 L30 80.2 L33 75.3 L36 69.4 L39 62.8 L42 56.1 L45 49.8 L48 44.6 L51 41.2 L54 40 L57 41.1 L60 44.4 L63 49.5 L66 55.6 L69 62.1 L72 68.1 L75 73.3 L78 77.1 L81 79.5 L84 80.3 L87 79.6 L90 77.5 L93 74.1 L96 69.6 L99 64.2 L102 58.2 L105 51.8 L108 45.5 L111 39.6 L114 34.6 L117 30.8 L120 28.6 L123 28 L126 29.3 L129 32.2 L132 36.5 L135 41.9 L138 48 L141 54.5 L144 60.8 L147 66.8 L150 72.2 L153 76.9 L156 80.8 L159 83.9 L162 86.3 L165 88.1 L168 89.4 L171 90.3 L174 90.9 L177 91.4 L180 91.6";

// The drawings inside the landing page's Tone curve and Histogram cards
// (site/index.html, cards c1 and c2), 180 units wide.
const TONE_CURVE =
  `<path d="M45 0V112M90 0V112M135 0V112M0 28H180M0 56H180M0 84H180" fill="none" stroke="${PRINT.ink}" stroke-opacity=".1"/>` +
  `<path d="M0 112L180 0" fill="none" stroke="${PRINT.ink}" stroke-opacity=".22" stroke-dasharray="3 4"/>` +
  `<path d="M0 112 C30 108 40 92 60 82 S110 34 130 22 S165 4 180 0" fill="none" stroke="${PRINT.red}" stroke-width="2.6"/>` +
  `<circle cx="60" cy="82" r="5" fill="${PRINT.card}" stroke="${PRINT.ink}" stroke-width="2"/>` +
  `<circle cx="130" cy="22" r="5" fill="${PRINT.card}" stroke="${PRINT.ink}" stroke-width="2"/>`;
const HISTOGRAM =
  `<path d="${HISTOGRAM_FILL}" fill="${PRINT.ink}" opacity=".85"/>` +
  `<path d="${HISTOGRAM_LINE}" fill="none" stroke="${PRINT.red}" stroke-width="2"/>`;

// One of the landing page's print cards, its CSS box drawn in SVG at the
// installer's size: 132 px wide, 2 px ink border, radius 9, 5 px hard shadow;
// a header with a red square, the title in tracked capitals and a muted ×;
// then the drawing at the 108 px content width. Top-left at 0 0.
function printCard(title, drawing, drawingHeight) {
  const w = 132;
  const bodyTop = 37.8;
  const h = round(bodyTop + (108 * drawingHeight) / 180 + 12);
  const times = font.charToGlyph("×");
  const tb = times.getBoundingBox();
  const ts = 12 / UPM;
  const timesX = w - 12 - tb.x2 * ts;
  const timesY = 14.4 + ((tb.y1 + tb.y2) / 2) * ts;
  return {
    h,
    body:
      `<rect x="5" y="5" width="${w}" height="${h}" rx="9" fill="${PRINT.ink}"/>` +
      `<rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="8" fill="${PRINT.card}" stroke="${PRINT.ink}" stroke-width="2"/>` +
      `<path d="M2 27.8H${w - 2}" stroke="${PRINT.ink}" stroke-width="2"/>` +
      `<rect x="12" y="10.9" width="7" height="7" fill="${PRINT.red}"/>` +
      `<path transform="translate(25 17.4)" d="${setCaps(title.toUpperCase(), 9, 0.2)}" fill="${PRINT.ink}"/>` +
      `<path transform="translate(${round(timesX)} ${round(timesY)})" d="${pathData(times.path.commands, 0, ts)}" fill="${PRINT.muted}"/>` +
      `<g transform="translate(12 ${bodyTop}) scale(0.6)">${drawing}</g>`,
  };
}

// NSIS welcome/finish art, 164 x 340 at 100 %: the hero's Tone curve and
// Histogram cards on paper, tilted as on the landing page. At high dpi the
// welcome image control grows taller than this ratio; the paper below the
// cards fills the difference.
function installerSidebar() {
  const place = (card, x, y, deg) =>
    `<g transform="translate(${x} ${y}) rotate(${deg} 66 ${round(card.h / 2)})">${card.body}</g>`;
  return svg(
    "0 0 164 340",
    `<rect width="164" height="340" fill="${PRINT.paper}"/>` +
      place(printCard("Tone curve", TONE_CURVE, 112), 10, 48, -4) +
      place(printCard("Histogram", HISTOGRAM, 92), 18, 178, 3),
  );
}

// NSIS inner-page header image, 150 x 57: the sticker 47 px tall,
// right-aligned on paper 16 px from the edge.
function installerHeader(box) {
  const h = 47;
  const w = (box.w * h) / box.h;
  return svg(
    "0 0 150 57",
    `<rect width="150" height="57" fill="${PRINT.paper}"/>` + embed(STICKER, box, 150 - 16 - w, (57 - h) / 2, h),
  );
}

// README banner, 2560 x 1280: the sticker at 70% height on darkroom.
const banner = (box) =>
  svg("0 0 2560 1280", `<rect width="2560" height="1280" fill="${DARKROOM}"/>` + embedCentred(STICKER, box, 2560, 1280, 896));

// Social preview, 1200 x 630: the sticker at 78% height on paper.
const ogCover = (box) =>
  svg("0 0 1200 630", `<rect width="1200" height="630" fill="${PRINT.paper}"/>` + embedCentred(STICKER, box, 1200, 630, 492));

async function main() {
  const write = (file, text) => fs.writeFileSync(path.join(LOGO, file), text);
  const box = await inkBox(STICKER);
  write("installer-sidebar.svg", installerSidebar());
  write("installer-header.svg", installerHeader(box));
  const bannerSvg = banner(box);
  write("banner.svg", bannerSvg);
  for (const target of ["public/favicon.svg", "site/favicon.svg", "art/favicon.svg"]) {
    fs.writeFileSync(path.join(ROOT, target), STAMP);
  }
  fs.writeFileSync(path.join(ROOT, "site", "logo.svg"), cropped(STICKER, box));
  await sharp(Buffer.from(ogCover(box))).jpeg({ quality: 90 }).toFile(path.join(ROOT, "site", "shots", "og-cover.jpg"));
  await sharp(Buffer.from(bannerSvg)).png().toFile(path.join(ROOT, "art", "Banner.png"));
  console.log(`logo assets written (sticker ink box ${box.x} ${box.y} ${box.w} ${box.h})`);
}

main().catch((err) => {
  console.error("build-logo failed:", err.message);
  process.exit(1);
});
