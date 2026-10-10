// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Builds every logo asset from Afacad Bold (SIL OFL 1.1, source/Afacad-Bold.ttf):
// the "safelight." wordmarks, the "s." icon drawings, the installer artwork, the
// favicons, the README banner and the landing site's wordmark and social
// preview. From the repo root:
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
const TRACKING = -10;
const COLOR = { red: "#f3223f", darkroom: "#0f0b0b", paper: "#f7f3ee" };
// The landing site's print palette (site/index.html), used by the installer art.
const PRINT = { paper: "#f3ece0", card: "#fbf8f2", ink: "#16110f", muted: "#5c514b", red: "#e5172f" };

const font = opentype.loadSync(path.join(LOGO, "source", "Afacad-Bold.ttf"));
const UPM = font.unitsPerEm;
const X_HEIGHT = font.tables.os2.sxHeight;
const round = (n) => Math.round(n * 100) / 100;

function contours(glyph) {
  const out = [];
  for (const c of glyph.path.commands) {
    if (c.type === "M") out.push([]);
    out[out.length - 1].push(c);
  }
  return out;
}

function bounds(commands) {
  const xs = [];
  const ys = [];
  for (const c of commands) {
    for (const k of ["x", "x1", "x2"]) if (c[k] !== undefined) xs.push(c[k]);
    for (const k of ["y", "y1", "y2"]) if (c[k] !== undefined) ys.push(c[k]);
  }
  return { x1: Math.min(...xs), x2: Math.max(...xs), y1: Math.min(...ys), y2: Math.max(...ys) };
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

// Thickness of the left stroke of "n" below its arch, in font units.
function stemWidth() {
  const y = X_HEIGHT * 0.3;
  const xs = [];
  const cross = (x0, y0, x1, y1) => {
    if ((y0 - y) * (y1 - y) < 0) xs.push(x0 + ((y - y0) * (x1 - x0)) / (y1 - y0));
  };
  for (const contour of contours(font.charToGlyph("n"))) {
    const start = contour[0];
    let px = start.x;
    let py = start.y;
    for (const c of contour.slice(1)) {
      if (c.type === "Z") {
        cross(px, py, start.x, start.y);
        continue;
      }
      for (let i = 1; i <= 24; i++) {
        const t = i / 24;
        const u = 1 - t;
        let x;
        let yy;
        if (c.type === "L") {
          x = px + (c.x - px) * t;
          yy = py + (c.y - py) * t;
        } else if (c.type === "Q") {
          x = u * u * px + 2 * u * t * c.x1 + t * t * c.x;
          yy = u * u * py + 2 * u * t * c.y1 + t * t * c.y;
        } else {
          x = u ** 3 * px + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t ** 3 * c.x;
          yy = u ** 3 * py + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t ** 3 * c.y;
        }
        cross(px, py, x, yy);
        px = x;
        py = yy;
      }
    }
  }
  xs.sort((a, b) => a - b);
  return xs[1] - xs[0];
}

const STEM = stemWidth();

/**
 * Sets `text` at `size` px with the i's dot and a trailing full stop drawn as
 * squares of side STEM. Baseline at y = 0, y down. Returns letter path data,
 * the squares, and the ink box (left, right, top, bottom) in px.
 */
function setWord(text, size) {
  const scale = size / UPM;
  const glyphs = font.stringToGlyphs(text);
  const squares = [];
  let pen = 0;
  let d = "";
  glyphs.forEach((glyph, i) => {
    if (i > 0) pen += font.getKerningValue(glyphs[i - 1], glyph) + TRACKING;
    const parts = contours(glyph);
    if (glyph.unicode === 0x69) {
      const boxes = parts.map(bounds);
      const dot = boxes.reduce((best, b, k) => (b.y1 > boxes[best].y1 ? k : best), 0);
      const stem = boxes[dot === 0 ? 1 : 0];
      const cx = (stem.x1 + stem.x2) / 2;
      squares.push({ x: (pen + cx - STEM / 2) * scale, y: -(boxes[dot].y1 + STEM) * scale, side: STEM * scale });
      parts.forEach((p, k) => {
        if (k !== dot) d += pathData(p, pen, scale);
      });
    } else {
      for (const p of parts) d += pathData(p, pen, scale);
    }
    pen += glyph.advanceWidth;
  });
  const period = font.charToGlyph(".");
  const stopX = pen + font.getKerningValue(glyphs[glyphs.length - 1], period) + TRACKING + period.leftSideBearing;
  squares.push({ x: stopX * scale, y: -STEM * scale, side: STEM * scale });
  const boxes = glyphs.map((g) => g.getBoundingBox());
  return {
    d,
    squares,
    xHeight: X_HEIGHT * scale,
    left: boxes[0].x1 * scale,
    right: (stopX + STEM) * scale,
    top: Math.min(-Math.max(...boxes.map((b) => b.y2)) * scale, ...squares.map((q) => q.y)),
    bottom: -Math.min(...boxes.map((b) => b.y1)) * scale,
  };
}

const rects = (squares, fill) =>
  squares.map((q) => `<rect x="${round(q.x)}" y="${round(q.y)}" width="${round(q.side)}" height="${round(q.side)}" fill="${fill}"/>`).join("");

const svg = (viewBox, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>\n`;

function squircle(size, n = 5, steps = 360) {
  const a = size / 2;
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    const c = Math.cos(t);
    const s = Math.sin(t);
    pts.push(`${round(a + a * Math.sign(c) * Math.abs(c) ** (2 / n))} ${round(a + a * Math.sign(s) * Math.abs(s) ** (2 / n))}`);
  }
  return `M${pts.join(" L")} Z`;
}

function wordmark(letters, squares) {
  const w = setWord("safelight", 200);
  const viewBox = [w.left, w.top, w.right - w.left, w.bottom - w.top].map(round).join(" ");
  return svg(viewBox, `<title>safelight.</title><path d="${w.d}" fill="${letters}"/>${rects(w.squares, squares)}`);
}

// "s." on a squircle tile. `snap` puts the baseline and the square on whole
// pixels and rounds the square, for the 16 and 32 px drawings.
function icon(grid, xHeight, snap) {
  const w = setWord("s", (xHeight / X_HEIGHT) * UPM);
  const stop = w.squares[0];
  let tx = grid / 2 - (w.left + w.right) / 2;
  let ty = grid / 2 - (w.top + w.bottom) / 2;
  let squares = w.squares;
  if (snap) {
    const side = Math.max(2, Math.round(stop.side));
    ty = Math.round(ty);
    tx = Math.round(tx + stop.x) - stop.x;
    squares = [{ x: stop.x, y: -side, side }];
  }
  return svg(
    `0 0 ${grid} ${grid}`,
    `<title>safelight.</title><defs><clipPath id="tile"><path d="${squircle(grid)}"/></clipPath></defs>` +
      `<g clip-path="url(#tile)"><rect width="${grid}" height="${grid}" fill="${COLOR.darkroom}"/>` +
      `<g transform="translate(${round(tx)} ${round(ty)})"><path d="${w.d}" fill="${COLOR.paper}"/>${rects(squares, COLOR.red)}</g></g>`,
  );
}

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

// NSIS inner-page header image, 150 x 57: the on-light wordmark, x-height
// 10 px, right-aligned on paper.
function installerHeader() {
  const w = setWord("safelight", (10 / X_HEIGHT) * UPM);
  const tx = 150 - 16 - (w.right - w.left) - w.left;
  const ty = Math.round(57 / 2 + w.xHeight / 2);
  return svg(
    "0 0 150 57",
    `<rect width="150" height="57" fill="${PRINT.paper}"/>` +
      `<g transform="translate(${round(tx)} ${ty})"><path d="${w.d}" fill="${PRINT.ink}"/>${rects(w.squares, PRINT.red)}</g>`,
  );
}

// README banner, 2560 x 1280: the wordmark at 56% width, centred on its x-height band.
function banner() {
  const w = setWord("safelight", 200);
  const k = (0.56 * 2560) / (w.right - w.left);
  const tx = (2560 - (w.right - w.left) * k) / 2 - w.left * k;
  const ty = 1280 / 2 + (w.xHeight / 2) * k;
  return svg(
    "0 0 2560 1280",
    `<rect width="2560" height="1280" fill="${COLOR.darkroom}"/>` +
      `<g transform="translate(${round(tx)} ${round(ty)}) scale(${round(k)})"><path d="${w.d}" fill="${COLOR.paper}"/>${rects(w.squares, COLOR.red)}</g>`,
  );
}

// Social preview, 1200 x 630: the on-light wordmark at 60% width on paper.
function ogCover() {
  const w = setWord("safelight", 200);
  const k = (0.6 * 1200) / (w.right - w.left);
  const tx = (1200 - (w.right - w.left) * k) / 2 - w.left * k;
  const ty = 630 / 2 + (w.xHeight / 2) * k;
  return svg(
    "0 0 1200 630",
    `<rect width="1200" height="630" fill="#f3ece0"/>` +
      `<g transform="translate(${round(tx)} ${round(ty)}) scale(${round(k)})"><path d="${w.d}" fill="${COLOR.darkroom}"/>${rects(w.squares, COLOR.red)}</g>`,
  );
}

async function main() {
  const write = (file, text) => fs.writeFileSync(path.join(LOGO, file), text);
  write("safelight-wordmark.svg", wordmark(COLOR.paper, COLOR.red));
  write("safelight-wordmark-on-light.svg", wordmark(COLOR.darkroom, COLOR.red));
  write("safelight-wordmark-mono-white.svg", wordmark("#ffffff", "#ffffff"));
  write("safelight-wordmark-mono-black.svg", wordmark("#000000", "#000000"));
  const master = icon(1024, 0.44 * 1024, false);
  write("safelight-icon.svg", master);
  write("safelight-icon-32.svg", icon(32, 15, true));
  write("safelight-icon-16.svg", icon(16, 8, true));
  write("installer-sidebar.svg", installerSidebar());
  write("installer-header.svg", installerHeader());
  const bannerSvg = banner();
  write("banner.svg", bannerSvg);
  for (const target of ["public/favicon.svg", "site/favicon.svg", "art/favicon.svg"]) {
    fs.writeFileSync(path.join(ROOT, target), master);
  }
  fs.writeFileSync(path.join(ROOT, "site", "wordmark.svg"), wordmark(COLOR.darkroom, COLOR.red));
  await sharp(Buffer.from(ogCover())).jpeg({ quality: 90 }).toFile(path.join(ROOT, "site", "shots", "og-cover.jpg"));
  await sharp(Buffer.from(bannerSvg)).png().toFile(path.join(ROOT, "art", "Banner.png"));
  console.log(`logo assets written (stem ${(STEM / UPM).toFixed(4)} em)`);
}

main().catch((err) => {
  console.error("build-logo failed:", err.message);
  process.exit(1);
});
