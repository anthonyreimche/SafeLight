// Generate the app icons and the Windows installer artwork:
//   icon.ico                16-256 px, each size from the drawing made for it
//   icon.png                1024 px (electron-builder derives Linux icons and
//                           the macOS .icns from it)
//   installer/sidebar-<scale>.bmp, installer/header-<scale>.bmp
//                           NSIS welcome/finish art (164 x 340) and inner-page
//                           header (150 x 57) at each Windows scaling;
//                           build/installer.nsh loads the display's one
//   installerSidebar.bmp, installerHeader.bmp
//                           the 100 % pair electron-builder is configured with
// Sources: public/favicon.svg and art/logo/ (see art/logo/README.md).
// Writes to build/ unless `--out <dir>` is given.

const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..");
const LOGO = path.join(ROOT, "art", "logo");
const MASTER = path.join(ROOT, "public", "favicon.svg");
const ICON_16 = path.join(LOGO, "safelight-icon-16.svg");
const ICON_32 = path.join(LOGO, "safelight-icon-32.svg");
const SIDEBAR = path.join(LOGO, "installer-sidebar.svg");
const HEADER = path.join(LOGO, "installer-header.svg");
const PAPER = { r: 243, g: 236, b: 224 };

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const INSTALLER_SCALES = [100, 125, 150, 175, 200, 250, 300];
const SIDEBAR_SIZE = [164, 340];
const HEADER_SIZE = [150, 57];

/** Pixel size of installer art drawn at `base` (100 %) for `scale` percent. */
function installerArtSize(base, scale) {
  return base.map((n) => Math.round((n * scale) / 100));
}

/** The drawing an icon size is rasterised from: pixel-fitted ones below 48 px. */
function iconSourceFor(size) {
  if (size <= 16) return { file: ICON_16, grid: 16 };
  if (size <= 32) return { file: ICON_32, grid: 32 };
  return { file: MASTER, grid: 1024 };
}

/** 24-bit uncompressed bottom-up BMP, the format NSIS wizard bitmaps need. */
function encodeBmp24(rgb, width, height) {
  const rowBytes = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowBytes * height;
  const out = Buffer.alloc(54 + pixelBytes);
  out.write("BM", 0, "ascii");
  out.writeUInt32LE(54 + pixelBytes, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(0, 30);
  out.writeUInt32LE(pixelBytes, 34);
  out.writeInt32LE(2835, 38);
  out.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y++) {
    const row = 54 + (height - 1 - y) * rowBytes;
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 3;
      out[row + x * 3] = rgb[src + 2];
      out[row + x * 3 + 1] = rgb[src + 1];
      out[row + x * 3 + 2] = rgb[src];
    }
  }
  return out;
}

function isUpToDate(outputs, sources) {
  if (!outputs.every((f) => fs.existsSync(f))) return false;
  const newest = Math.max(...sources.map((f) => fs.statSync(f).mtimeMs));
  return outputs.every((f) => fs.statSync(f).mtimeMs >= newest);
}

async function main(outDir) {
  const sharp = require("sharp");
  // png-to-ico v3 ships as an ESM default export; under require() it lands on
  // `.default`. Handle both shapes.
  const pngToIcoMod = require("png-to-ico");
  const pngToIco = pngToIcoMod.default || pngToIcoMod;

  const out = {
    ico: path.join(outDir, "icon.ico"),
    png: path.join(outDir, "icon.png"),
    sidebar: path.join(outDir, "installerSidebar.bmp"),
    header: path.join(outDir, "installerHeader.bmp"),
  };
  const scaled = (name, scale) => path.join(outDir, "installer", `${name}-${scale}.bmp`);
  const outputs = [
    ...Object.values(out),
    ...INSTALLER_SCALES.flatMap((s) => [scaled("sidebar", s), scaled("header", s)]),
  ];
  const sources = [MASTER, ICON_16, ICON_32, SIDEBAR, HEADER];
  for (const f of sources) {
    if (!fs.existsSync(f)) throw new Error(`icon source not found: ${f}`);
  }
  if (isUpToDate(outputs, sources)) {
    console.log("icon up to date - skipping.");
    return;
  }
  fs.mkdirSync(path.join(outDir, "installer"), { recursive: true });

  // Rendering each SVG straight at its target size (density scales the
  // viewBox) keeps the pixel-fitted drawings on their pixel grid.
  const render = (file, grid, size) =>
    sharp(fs.readFileSync(file), { density: (72 * size) / grid }).resize(size, size).png().toBuffer();

  const pngs = await Promise.all(
    ICO_SIZES.map((size) => {
      const { file, grid } = iconSourceFor(size);
      return render(file, grid, size);
    }),
  );
  const ico = await pngToIco(pngs);
  fs.writeFileSync(out.ico, ico);
  fs.writeFileSync(out.png, await render(MASTER, 1024, 1024));

  // Each scale is drawn from the SVG at that density, not resampled from
  // another size, so every one is sharp.
  const bmp = async (file, base, scale) => {
    const [width, height] = installerArtSize(base, scale);
    const { data } = await sharp(fs.readFileSync(file), { density: 0.72 * scale })
      .resize(width, height)
      .flatten({ background: PAPER })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return encodeBmp24(data, width, height);
  };
  for (const scale of INSTALLER_SCALES) {
    const sidebar = await bmp(SIDEBAR, SIDEBAR_SIZE, scale);
    const header = await bmp(HEADER, HEADER_SIZE, scale);
    fs.writeFileSync(scaled("sidebar", scale), sidebar);
    fs.writeFileSync(scaled("header", scale), header);
    if (scale === 100) {
      fs.writeFileSync(out.sidebar, sidebar);
      fs.writeFileSync(out.header, header);
    }
  }

  console.log(
    `icon -> ${out.ico} (${ico.length} bytes, sizes: ${ICO_SIZES.join(",")}) + icon.png (1024px)` +
      ` + installer art at ${INSTALLER_SCALES.join(",")}%`,
  );
}

if (require.main === module) {
  const at = process.argv.indexOf("--out");
  const outDir = at > 0 ? path.resolve(process.argv[at + 1]) : path.join(ROOT, "build");
  main(outDir).catch((err) => {
    console.error("make-icon failed:", err.message);
    process.exit(1);
  });
}

module.exports = { ICO_SIZES, INSTALLER_SCALES, iconSourceFor, encodeBmp24, installerArtSize };
