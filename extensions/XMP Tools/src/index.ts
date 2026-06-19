// XMP Tools — optional SafeLight extension.
//
// Owns everything XMP: reads sidecar metadata on import, writes sidecars on
// metadata/edit changes, deletes them on removal, and teaches the Presets panel
// to import Lightroom (.xmp) presets. The app core no longer knows about XMP —
// it just emits catalog lifecycle hooks this extension subscribes to.

import type { SafelightAPI } from "./safelight";
import {
  readXmpSidecar,
  writeXmpSidecar,
  deleteXmpSidecar,
  xmpToPhotoOverrides,
} from "./xmp";
import { parseLightroomXmp } from "./lightroom-import";

const WRITE_KEY = "writeXmpSidecars";

export function activate(api: SafelightAPI): void {
  const writeEnabled = () => api.settings.get(WRITE_KEY, false);

  // Settings dialog (⚙ in the Extensions panel) — replaces the old core toggle.
  api.registerSettings({
    title: "XMP Tools",
    fields: [
      {
        key: WRITE_KEY,
        label: "Write XMP sidecars",
        hint: "Save ratings, labels, keywords, and edits to .xmp files alongside your images. Enables interoperability with Lightroom, Darktable, and other photo tools.",
        type: "boolean",
        default: false,
      },
    ],
  });

  api.registerCatalogHooks({
    id: "com.safelight.xmp-tools.sidecars",

    // Read sidecar metadata when a photo is discovered; merged with precedence.
    async onPhotoImport({ dir, fileName }) {
      const xmp = await readXmpSidecar(dir, fileName);
      return xmp ? xmpToPhotoOverrides(xmp) : undefined;
    },

    // Write sidecars after rating/label/flag/keyword changes.
    async onMetadataChange({ photos, getEditState }) {
      if (!writeEnabled()) return;
      for (const p of photos) {
        if (!p.directoryHandle || !p.fileHandle) continue;
        try {
          const editState = await getEditState(p.id);
          await writeXmpSidecar(
            p.directoryHandle,
            p.fileHandle.name,
            p,
            editState ?? undefined,
          );
        } catch (e) {
          console.warn(`[xmp] failed to write sidecar for ${p.filename}:`, e);
        }
      }
    },

    // Write a sidecar with the full edit params after a develop commit.
    async onEditCommit({ photo, editState }) {
      if (!writeEnabled()) return;
      if (!photo.directoryHandle || !photo.fileHandle) return;
      try {
        await writeXmpSidecar(photo.directoryHandle, photo.fileHandle.name, photo, editState, {
          includePrivateNamespace: true,
        });
      } catch (e) {
        console.warn(`[xmp] failed to write sidecar for ${photo.filename}:`, e);
      }
    },

    // Delete the sidecar when its photo is removed.
    async onPhotoRemove({ dir, fileName }) {
      await deleteXmpSidecar(dir, fileName);
    },
  });

  // Lightroom preset import for the Presets panel.
  api.registerPresetImporter({
    id: "com.safelight.xmp-tools.lightroom",
    label: "Lightroom preset (.xmp)",
    extensions: [".xmp"],
    async parse(file) {
      const text = await file.text();
      const fallback = file.name.replace(/\.xmp$/i, "");
      return parseLightroomXmp(text, fallback);
    },
  });
}

export function deactivate(): void {
  // No standing side effects: the host sweeps our registry contributions
  // (settings, hooks, importer) on disable/uninstall.
}
