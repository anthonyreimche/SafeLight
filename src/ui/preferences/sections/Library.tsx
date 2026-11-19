// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { updateSettings, useSettings } from "@/state/settings-store";
import { useUIStore } from "@/state/ui-store";
import type { SortDirection, SortField } from "@/catalog/types";
import { Select } from "@/ui/components/Select";
import { Field, SliderField, ToggleField } from "@/ui/preferences/fields";
import { settings, type PrefSection } from "@/ui/preferences/section-model";

const SORT_FIELDS: { value: SortField; label: string }[] = [
  { value: "dateImported", label: "Date imported" },
  { value: "dateCreated", label: "Date created" },
  { value: "dateEdited", label: "Date edited" },
  { value: "filename", label: "Filename" },
  { value: "rating", label: "Rating" },
];

export function LibrarySection() {
  const s = useSettings();
  return (
    <div className="flex flex-col gap-4">
      <SliderField
        label="Default grid size"
        value={s.defaultGridSize}
        min={120}
        max={360}
        step={10}
        format={(v) => `${v} px`}
        onChange={(v) => {
          updateSettings({ defaultGridSize: v });
          useUIStore.getState().setGridSize(v); // apply live
        }}
      />
      <Field label="Default sort">
        <div className="flex gap-1.5">
          <Select
            value={s.defaultSortField}
            onChange={(v) => {
              updateSettings({ defaultSortField: v as SortField });
              useUIStore.getState().setSort(v, s.defaultSortDirection); // apply live
            }}
            ariaLabel="Default sort field"
            className="flex-1"
            options={SORT_FIELDS.map((f) => ({ value: f.value, label: f.label }))}
          />
          <Select
            value={s.defaultSortDirection}
            onChange={(v) => {
              updateSettings({ defaultSortDirection: v as SortDirection });
              useUIStore.getState().setSort(s.defaultSortField, v as SortDirection); // apply live
            }}
            ariaLabel="Default sort direction"
            className="flex-1"
            options={[
              { value: "desc", label: "Descending" },
              { value: "asc", label: "Ascending" },
            ]}
          />
        </div>
      </Field>
      <ToggleField
        label="Show photos in subfolders"
        hint="When a folder is selected, also show photos from its subfolders. Off shows only photos directly inside the selected folder."
        checked={s.showSubfolderPhotos}
        onChange={(v) => updateSettings({ showSubfolderPhotos: v })}
      />
      <ToggleField
        label="Mark edited photos"
        hint="Show a pencil on the thumbnails in the grid and the Filmstrip of photos you've edited. Undoing every edit takes it away."
        checked={s.thumbnailEdited}
        onChange={(v) => updateSettings({ thumbnailEdited: v })}
      />
      <ToggleField
        label="Show file type on thumbnails"
        hint="Mark each thumbnail in the grid and the Filmstrip with its file type, such as NEF, DNG or JPG, to tell a RAW from its JPEG at a glance."
        checked={s.thumbnailFileType}
        onChange={(v) => updateSettings({ thumbnailFileType: v })}
      />
      <ToggleField
        label="Confirm before removing photos"
        hint="Ask for confirmation when removing photos from the catalogue. Remove never deletes the originals on disk; Delete from disk is a separate action that always asks."
        checked={s.confirmRemovePhotos}
        onChange={(v) => updateSettings({ confirmRemovePhotos: v })}
      />
    </div>
  );
}

export const librarySection: PrefSection = {
  id: "Library",
  label: "Library",
  group: "General",
  items: settings(
    "Default grid size",
    "Default sort",
    "Show photos in subfolders",
    "Confirm before removing photos",
  ),
  keywords: [],
  render: () => <LibrarySection />,
};
