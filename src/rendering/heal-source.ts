// Auto-pick a heal source location.
//
// When a heal spot is created we want its source to come from a nearby area
// whose *surroundings* look like the spot's surroundings — then copying it in is
// seamless. We sample a ring of pixels just outside the spot and search a set of
// nearby candidate centres for the one whose ring best matches. Operates on the
// small downscaled source the renderer already captured, so it's cheap and runs
// once per spot (not per frame).

let img: Uint8ClampedArray | null = null;
let iw = 0;
let ih = 0;

export function setHealSourceImage(data: Uint8ClampedArray, w: number, h: number) {
  img = data;
  iw = w;
  ih = h;
}

function sampleRGB(uvx: number, uvy: number): [number, number, number] {
  const x = Math.min(iw - 1, Math.max(0, Math.round(uvx * iw)));
  const y = Math.min(ih - 1, Math.max(0, Math.round(uvy * ih)));
  const i = (y * iw + x) * 4;
  return [img![i], img![i + 1], img![i + 2]];
}

export interface HealSource {
  x: number;
  y: number;
}

// dstX/dstY/radius are in source-UV space (radius in image-height units); aspect
// is width/height so the search stays circular on screen. Returns a source
// centre in source-UV, or null if no usable candidate (caller keeps its default).
export function findHealSource(
  dstX: number,
  dstY: number,
  radius: number,
  aspect: number,
): HealSource | null {
  if (!img || iw === 0 || ih === 0) return null;

  const RING = 12;
  const ringR = Math.max(radius * 1.4, 0.01); // just outside the spot
  const dstRing: number[] = [];
  for (let k = 0; k < RING; k++) {
    const a = (k / RING) * Math.PI * 2;
    const [r, g, b] = sampleRGB(
      dstX + (Math.cos(a) * ringR) / aspect,
      dstY + Math.sin(a) * ringR,
    );
    dstRing.push(r, g, b);
  }

  const dirs = 16;
  const dists = [2.2, 3.6, 5.2]; // multiples of the radius, all clear of the spot
  let best: HealSource | null = null;
  let bestErr = Infinity;
  for (const dm of dists) {
    const dist = radius * dm;
    for (let d = 0; d < dirs; d++) {
      const a = (d / dirs) * Math.PI * 2;
      const cx = dstX + (Math.cos(a) * dist) / aspect;
      const cy = dstY + Math.sin(a) * dist;
      // keep the whole sampling ring inside the frame
      if (cx < 0.02 || cx > 0.98 || cy < 0.02 || cy > 0.98) continue;
      let err = 0;
      for (let k = 0; k < RING; k++) {
        const ra = (k / RING) * Math.PI * 2;
        const [r, g, b] = sampleRGB(
          cx + (Math.cos(ra) * ringR) / aspect,
          cy + Math.sin(ra) * ringR,
        );
        const dr = r - dstRing[k * 3];
        const dg = g - dstRing[k * 3 + 1];
        const db = b - dstRing[k * 3 + 2];
        err += dr * dr + dg * dg + db * db;
      }
      if (err < bestErr) {
        bestErr = err;
        best = { x: cx, y: cy };
      }
    }
  }
  return best;
}
