import { useRef } from "react";
import type { CatalogPhoto } from "@/catalog/types";
import { useDevelopRenderer } from "@/hooks/use-develop-renderer";
import { ViewportImage } from "@/ui/ViewportImage";

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
    />
  );
}
