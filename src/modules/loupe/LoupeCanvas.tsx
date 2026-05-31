import { useRef } from "react";
import type { CatalogPhoto } from "@/catalog/types";
import { useLoupeRenderer } from "@/hooks/use-loupe-renderer";
import { ViewportImage } from "@/ui/ViewportImage";

export function LoupeCanvas({
  photo,
  showBefore,
  zoom,
  onZoomChange,
}: {
  photo: CatalogPhoto;
  showBefore: boolean;
  zoom: number | null;
  onZoomChange: (zoom: number | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { supported, loading, width, height } = useLoupeRenderer(
    canvasRef,
    photo,
    showBefore,
  );

  if (!supported) {
    return (
      <div className="flex flex-col items-center gap-2 text-center text-text-muted">
        {photo.thumbnailUrl && (
          <img
            src={photo.thumbnailUrl}
            alt={photo.filename}
            className="max-h-full max-w-full object-contain opacity-80"
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
    />
  );
}
