// Generate build/icon.ico from public/favicon.svg.
// Windows .exe icons must be .ico; electron-builder picks up build/icon.ico
// automatically. We rasterize the SVG to several PNG sizes with sharp, then
// pack them into a single multi-resolution .ico with png-to-ico.

const path = require("node:path");
const fs = require("node:fs");

async function main() {
  const sharp = require("sharp");
  // png-to-ico v3 ships as an ESM default export; under require() it lands on
  // `.default`. Handle both shapes.
  const pngToIcoMod = require("png-to-ico");
  const pngToIco = pngToIcoMod.default || pngToIcoMod;

  const root = path.join(__dirname, "..");
  const svgPath = path.join(root, "public", "favicon.svg");
  const outDir = path.join(root, "build");
  const outIco = path.join(outDir, "icon.ico");

  if (!fs.existsSync(svgPath)) {
    throw new Error(`favicon.svg not found at ${svgPath}`);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const svg = fs.readFileSync(svgPath);
  const pngs = await Promise.all(
    sizes.map((size) =>
      sharp(svg, { density: 384 })
        .resize(size, size, { fit: "contain" })
        .png()
        .toBuffer(),
    ),
  );

  // png-to-ico's default 256px output is used by electron-builder as the
  // master; also drop a 256 PNG for any png-based targets.
  const ico = await pngToIco(pngs);
  fs.writeFileSync(outIco, ico);
  fs.writeFileSync(path.join(outDir, "icon.png"), pngs[pngs.length - 1]);

  console.log(`icon -> ${outIco} (${ico.length} bytes, sizes: ${sizes.join(",")})`);
}

main().catch((err) => {
  console.error("make-icon failed:", err.message);
  process.exit(1);
});
