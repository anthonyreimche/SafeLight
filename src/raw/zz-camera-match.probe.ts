// TEMPORARY probe (camera-match investigation, 2026-10-27); delete after use.
// Runs the app's own decode, preview extraction and camera match on one NEF and
// reports the numbers by throwing (browser console output isn't forwarded).
import { it } from "vitest";
import { decodeRawToFloat } from "@/raw/decode";
import { extractRawPreview } from "@/modules/library/raw-preview";
import { acceptDecode } from "@/raw/accept-decode";
import { lumaSamples } from "@/raw/camera-match";

const PCT = [5, 10, 25, 50, 75, 90, 95, 99];
const pct = (v: ArrayLike<number>) => {
  const s = Float32Array.from(v).sort();
  return PCT.map((p) => +s[Math.round((p / 100) * (s.length - 1))].toFixed(4));
};

it("probe", async () => {
  const path = "D:/Photos/2026/2026 10 18/DSC_0217.NEF";
  const res = await fetch("/@fs/" + encodeURI(path));
  const file = new File([await res.blob()], "DSC_0217.NEF");
  const f = await decodeRawToFloat(file);
  if ("failure" in f) throw new Error("decode failed " + JSON.stringify(f));
  const preview = await extractRawPreview(file);
  const verdict = await acceptDecode(f, f, preview);
  let previewPct: number[] | string = "no preview";
  let previewSize = "";
  if (preview) {
    const bm = await createImageBitmap(preview);
    previewSize = `${bm.width}x${bm.height} ${preview.size} bytes`;
    const c = new OffscreenCanvas(64, 64);
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("no 2d");
    ctx.drawImage(bm, 0, 0, 64, 64);
    const px = ctx.getImageData(0, 0, 64, 64).data;
    const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const l: number[] = [];
    for (let i = 0; i < px.length; i += 4) l.push(0.2126 * lin(px[i] / 255) + 0.7152 * lin(px[i + 1] / 255) + 0.0722 * lin(px[i + 2] / 255));
    previewPct = pct(l);
  }
  throw new Error(
    "REPORT " +
      JSON.stringify({
        size: [f.width, f.height],
        keys: Object.keys(f),
        verdict,
        scenePct: pct(lumaSamples(f.data)),
        previewSize,
        previewPct,
      }),
  );
});
