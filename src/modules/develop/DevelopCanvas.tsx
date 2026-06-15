import { useRef } from "react";
import type { CatalogPhoto, CropRect } from "@/catalog/types";
import { HSL_CHANNELS } from "@/catalog/types";
import { useDevelopRenderer } from "@/hooks/use-develop-renderer";
import { useDevelopStore } from "@/state/develop-store";
import { fitCropToImage, transformedViewCrop } from "@/rendering/crop-transform";
import {
  buildForwardTransform,
  buildInverseTransform,
} from "@/rendering/transform";
import { ViewportImage } from "@/ui/ViewportImage";
import { CropOverlay } from "./CropOverlay";
import { MaskOverlay } from "./MaskOverlay";
import { useAutoAdjust } from "@/hooks/use-auto-adjust";
import { sampleLinearRGB } from "@/rendering/sample-pixel";

// HSL hue centers matching the shader
const HSL_CENTERS = [0, 30, 60, 120, 180, 240, 280, 320];

// Calculate weights for each HSL channel at a given hue (same formula as shader)
function getHSLWeights(hueDeg: number): number[] {
  return HSL_CENTERS.map((center) => {
    const dist = Math.abs(((hueDeg - center + 540) % 360) - 180);
    return Math.max(0, 1 - dist / 35);
  });
}

// Get RGB to hue
function rgbToHue(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let hue = 0;
  if (max === r) {
    hue = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  } else if (max === g) {
    hue = ((b - r) / d + 2) / 6;
  } else {
    hue = ((r - g) / d + 4) / 6;
  }
  return hue * 360;
}

export function DevelopCanvas({
  photo,
  zoom,
  onZoomChange,
}: {
  photo: CatalogPhoto;
  zoom: number | null;
  onZoomChange: (zoom: number | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { supported, loading, width, height } = useDevelopRenderer(
    canvasRef,
    photo,
  );

  const cropping = useDevelopStore((s) => s.cropping);
  const activeTool = useDevelopStore((s) => s.activeTool);
  const crop = useDevelopStore((s) => s.params.crop);
  const straighten = useDevelopStore((s) => s.params.straighten);
  const transform = useDevelopStore((s) => s.params.transform);
  const cropAspect = useDevelopStore((s) => s.cropAspect);
  const constrainCrop = useDevelopStore((s) => s.constrainCrop);
  const cropGuide = useDevelopStore((s) => s.cropGuide);
  const cropGuideFlip = useDevelopStore((s) => s.cropGuideFlip);
  const setParam = useDevelopStore((s) => s.setParam);
  const commitEdit = useDevelopStore((s) => s.commitEdit);
  const wbPicking = useDevelopStore((s) => s.wbPicking);
  const setWbPicking = useDevelopStore((s) => s.setWbPicking);
  const hslPicking = useDevelopStore((s) => s.hslPicking);
  const hsl = useDevelopStore((s) => s.params.hsl);
  const setHslValue = useDevelopStore((s) => s.setHslValue);
  const { whiteBalanceFromSample } = useAutoAdjust();

  // HSL picker drag state
  const dragState = useRef<{
    active: boolean;
    startY: number;
    baseHue: number;
    weights: number[];
    initialValues: { hue: number[]; sat: number[]; lum: number[] };
  } | null>(null);

  // Handle WB pick (simple click)
  const onWbPick = (bx: number, by: number) => {
    setWbPicking(false);
    const cv = canvasRef.current;
    if (!cv) return;
    void whiteBalanceFromSample(() => sampleLinearRGB(cv, bx, by));
  };

  // HSL picker: click+drag to adjust nearest HSL sliders
  const selectedHslBand = useDevelopStore((s) => s.selectedHslBand);

  const onHslPointerDown = (bx: number, by: number) => {
    const cv = canvasRef.current;
    if (!cv) return;

    const rgb = sampleLinearRGB(cv, bx, by);
    if (!rgb) return;

    const [r, g, bVal] = rgb;
    const hueDeg = rgbToHue(r, g, bVal);
    const weights = getHSLWeights(hueDeg);

    // Store initial slider values for all channels
    dragState.current = {
      active: true,
      startY: by,
      baseHue: hueDeg,
      weights,
      initialValues: {
        hue: HSL_CHANNELS.map((ch) => hsl.hue[ch]),
        sat: HSL_CHANNELS.map((ch) => hsl.saturation[ch]),
        lum: HSL_CHANNELS.map((ch) => hsl.luminance[ch]),
      },
    };
  };

  const onHslPointerMove = (_bx: number, by: number) => {
    if (!dragState.current?.active) return;

    const dy = by - dragState.current.startY;

    // Drag up/down adjusts the selected band (sensitivity: 0.5 per pixel)
    // Up = increase value
    const delta = -dy * 0.5;

    // Apply weighted adjustments to all channels based on selected band
    dragState.current.weights.forEach((weight, i) => {
      if (weight < 0.01) return; // Skip channels with negligible influence

      const channel = HSL_CHANNELS[i];
      const effectiveWeight = weight * weight; // Square for smoother falloff

      const initialValue = dragState.current!.initialValues[selectedHslBand === "hue" ? "hue" : selectedHslBand === "saturation" ? "sat" : "lum"][i];
      const newValue = initialValue + delta * effectiveWeight;

      setHslValue(selectedHslBand, channel, Math.max(-100, Math.min(100, newValue)));
    });
  };

  const onHslPointerUp = () => {
    if (dragState.current?.active) {
      dragState.current = null;
      commitEdit("HSL Picker");
    }
  };

  const imageAspect = photo.height > 0 ? photo.width / photo.height : 1;
  // Inverse transform (transformed coord -> source UV) for crop constraints, the
  // forward transform (image quad) for the move clamp, and the view region
  // enclosing the warped image for the crop overlay.
  const inv = buildInverseTransform(straighten, transform, imageAspect);
  const forward = buildForwardTransform(straighten, transform, imageAspect);
  const viewCrop = transformedViewCrop(forward);

  // Throttle crop writes to one per frame so a drag doesn't re-render the panels
  // on every pointer event.
  const pendingCrop = useRef<CropRect | null>(null);
  const rafRef = useRef<number | null>(null);
  const pushCrop = (next: CropRect) => {
    pendingCrop.current = next;
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (pendingCrop.current) setParam("crop", pendingCrop.current);
      });
    }
  };
  const flushCrop = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (pendingCrop.current) {
      setParam("crop", pendingCrop.current);
      pendingCrop.current = null;
    }
  };

  if (!supported) {
    return (
      <div className="flex flex-col items-center gap-2 text-center text-text-muted">
        {photo.thumbnailUrl && (
          <img
            src={photo.thumbnailUrl}
            alt={photo.filename}
            className="max-h-[80vh] max-w-full object-contain opacity-80"
          />
        )}
        <p className="text-xs">WebGL 2 unavailable — showing unedited preview</p>
      </div>
    );
  }

  return (
    <ViewportImage
      canvasRef={canvasRef}
      bufferWidth={width}
      bufferHeight={height}
      zoom={zoom}
      onZoomChange={onZoomChange}
      loading={loading}
      resetKey={photo.id}
      overlayZoomable={!cropping && activeTool !== "none"}
      onPick={wbPicking && !cropping && activeTool === "none" ? onWbPick : undefined}
      onPickDrag={
        hslPicking && !cropping && activeTool === "none"
          ? {
              onDown: onHslPointerDown,
              onMove: onHslPointerMove,
              onUp: onHslPointerUp,
            }
          : null
      }
      overlay={
        cropping
          ? (rect) => (
              <CropOverlay
                rect={rect}
                crop={crop}
                viewCrop={viewCrop}
                inv={inv}
                forward={forward}
                straightenDeg={straighten}
                aspect={cropAspect}
                imageAspect={imageAspect}
                constrain={constrainCrop}
                guide={cropGuide}
                guideFlip={cropGuideFlip}
                onChange={pushCrop}
                onCommit={() => {
                  flushCrop();
                  commitEdit("Crop");
                }}
                onLevel={(deg) => {
                  setParam("straighten", deg);
                  if (constrainCrop) {
                    setParam(
                      "crop",
                      fitCropToImage(
                        crop,
                        buildInverseTransform(deg, transform, imageAspect),
                      ),
                    );
                  }
                  commitEdit("Straighten");
                }}
              />
            )
          : activeTool !== "none"
            ? (rect) => (
                <MaskOverlay
                  rect={rect}
                  crop={crop}
                  inv={inv}
                  forward={forward}
                  imageAspect={imageAspect}
                />
              )
            : undefined
      }
    />
  );
}
