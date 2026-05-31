import type { CatalogPhoto } from "./types";
import { extractRawPreview, isRawFile } from "@/modules/library/raw-preview";
import { decodeRawToBitmap } from "@/raw/decode";
import { rotateBitmap } from "./orient";

// Decode a photo to a full(er)-resolution bitmap for editing/preview. Prefers
// the original file via its handle; for RAW it attempts a true sensor decode and
// falls back to the embedded JPEG preview, then to the stored thumbnail when the
// handle is gone or permission was not re-granted.
//
// We decode raw pixels (imageOrientation: "none") and apply the photo's baked
// rotation ourselves, so orientation is consistent across JPEG and RAW. The
// stored thumbnail is already upright, so it is used as-is.
export async function loadPhotoBitmap(
  photo: CatalogPhoto,
): Promise<ImageBitmap | null> {
  if (photo.fileHandle) {
    try {
      const file = await photo.fileHandle.getFile();
      let raw: ImageBitmap | null = null;

      if (isRawFile(file)) {
        raw = await decodeRawToBitmap(file);
        if (!raw) {
          const preview = await extractRawPreview(file);
          raw = preview
            ? await createImageBitmap(preview, { imageOrientation: "none" })
            : null;
        }
      } else {
        raw = await createImageBitmap(file, { imageOrientation: "none" });
      }

      if (raw) {
        const upright = await rotateBitmap(raw, photo.rotation ?? 0);
        if (upright !== raw) raw.close();
        return upright;
      }
    } catch {
      // fall through to the stored thumbnail
    }
  }

  // Fallback: the stored thumbnail is already baked upright.
  if (photo.thumbnailBlob) {
    try {
      return await createImageBitmap(photo.thumbnailBlob, {
        imageOrientation: "none",
      });
    } catch {
      return null;
    }
  }
  return null;
}
