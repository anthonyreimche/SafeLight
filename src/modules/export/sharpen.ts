// Output sharpening via unsharp mask (USM). Applied after the WebGL develop
// pipeline renders to canvas and before JPEG/PNG/WebP encoding, so there is no
// decode→re-encode quality loss. Uses the browser's hardware-accelerated
// Gaussian blur (CanvasRenderingContext2D.filter) for the blur pass.

export function applyOutputSharpening(
  source: HTMLCanvasElement,
  amount: number,
  radius: number,
): HTMLCanvasElement {
  const w = source.width;
  const h = source.height;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(source, 0, 0);

  const blurCanvas = document.createElement("canvas");
  blurCanvas.width = w;
  blurCanvas.height = h;
  const blurCtx = blurCanvas.getContext("2d")!;
  blurCtx.filter = `blur(${radius}px)`;
  blurCtx.drawImage(source, 0, 0);

  const origData = ctx.getImageData(0, 0, w, h);
  const blurData = blurCtx.getImageData(0, 0, w, h);
  const src = origData.data;
  const blur = blurData.data;

  const f = amount / 100;
  for (let i = 0; i < src.length; i += 4) {
    src[i] = src[i] + f * (src[i] - blur[i]);
    src[i + 1] = src[i + 1] + f * (src[i + 1] - blur[i + 1]);
    src[i + 2] = src[i + 2] + f * (src[i + 2] - blur[i + 2]);
  }

  ctx.putImageData(origData, 0, 0);
  return canvas;
}
