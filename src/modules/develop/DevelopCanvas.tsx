import { useRef } from "react";
import type { CatalogPhoto, CropRect } from "@/catalog/types";
import { useDevelopRenderer } from "@/hooks/use-develop-renderer";
import { useDevelopStore } from "@/state/develop-store";
import { fitCropToImage, transformedViewCrop } from "@/rendering/crop-transform";
import {
  buildForwardTransform,
  buildInverseTransform,
} from "@/rendering/transform";
import { ViewportImage } from "@/ui/ViewportImage";
import { CropOverlay } from "./CropOverlay";

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
  const crop = useDevelopStore((s) => s.params.crop);
  const straighten = useDevelopStore((s) => s.params.straighten);
  const transform = useDevelopStore((s) => s.params.transform);
  const cropAspect = useDevelopStore((s) => s.cropAspect);
  const constrainCrop = useDevelopStore((s) => s.constrainCrop);
  const cropGuide = useDevelopStore((s) => s.cropGuide);
  const cycleCropGuide = useDevelopStore((s) => s.cycleCropGuide);
  const setParam = useDevelopStore((s) => s.setParam);
  const commitEdit = useDevelopStore((s) => s.commitEdit);

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
                onCycleGuide={cycleCropGuide}
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
          : undefined
      }
    />
  );
}
