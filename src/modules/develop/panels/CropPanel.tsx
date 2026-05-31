import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { useDevelopStore } from "@/state/develop-store";
import { useCatalogStore } from "@/state/catalog-store";
import { DEFAULT_CROP } from "@/catalog/types";
import { computeCropForAspect } from "@/rendering/crop-transform";

// ratio is width:height in pixels; 0 means "Original" (full frame).
const ASPECTS: { label: string; ratio: number }[] = [
  { label: "Original", ratio: 0 },
  { label: "1:1", ratio: 1 },
  { label: "3:2", ratio: 3 / 2 },
  { label: "2:3", ratio: 2 / 3 },
  { label: "4:3", ratio: 4 / 3 },
  { label: "16:9", ratio: 16 / 9 },
];

export function CropPanel() {
  const straighten = useDevelopStore((s) => s.params.straighten);
  const setParam = useDevelopStore((s) => s.setParam);
  const commitEdit = useDevelopStore((s) => s.commitEdit);
  const activePhotoId = useCatalogStore((s) => s.activePhotoId);
  const photos = useCatalogStore((s) => s.photos);

  const photo = photos.find((p) => p.id === activePhotoId);
  const imageAspect = photo && photo.height > 0 ? photo.width / photo.height : 1;

  const applyAspect = (ratio: number) => {
    const crop =
      ratio <= 0 ? { ...DEFAULT_CROP } : computeCropForAspect(ratio, imageAspect);
    setParam("crop", crop);
    commitEdit("Crop");
  };

  const resetCrop = () => {
    setParam("crop", { ...DEFAULT_CROP });
    setParam("straighten", 0);
    commitEdit("Crop reset");
  };

  return (
    <Panel title="Crop & Straighten" defaultOpen={false}>
      <div className="space-y-2">
        <div className="grid grid-cols-3 gap-1">
          {ASPECTS.map((a) => (
            <button
              key={a.label}
              onClick={() => applyAspect(a.ratio)}
              className="rounded bg-surface-2 px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-3 hover:text-text-primary"
            >
              {a.label}
            </button>
          ))}
        </div>

        <Slider
          label="Straighten"
          value={straighten}
          min={-45}
          max={45}
          step={0.1}
          onChange={(v) => setParam("straighten", v)}
          onCommit={() => commitEdit("Straighten")}
        />

        <button
          onClick={resetCrop}
          className="w-full rounded bg-surface-2 px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-3 hover:text-text-primary"
        >
          Reset crop
        </button>
      </div>
    </Panel>
  );
}
