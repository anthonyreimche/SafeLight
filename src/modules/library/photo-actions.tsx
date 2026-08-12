// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The photo right-click menu and the dialogs it opens (rename, copy settings),
// shared by every surface that lists photos: the Library grid, the list view,
// and extension surfaces such as the Filmstrip (via api.catalog.usePhotoActions).
// One implementation means a strip's menu can never drift from the grid's, and
// extension-contributed items (registerGridMenuItem) appear in both.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DevelopParams } from "@/catalog/types";
import { useCatalogStore } from "@/state/catalog-store";
import { useUIStore } from "@/state/ui-store";
import { ContextMenu, type ContextMenuEntry } from "@/ui/components/ContextMenu";
import { splitFilename } from "@/catalog/copy-name";
import { CopySettingsDialog } from "./CopySettingsDialog";
import { RenamePhotoDialog } from "./RenamePhotoDialog";
import { useGridMenuItems } from "@/extensions/registry";
import { exportPhotoData, renamePhoto, revealPhoto } from "@/project/folder-ops";
import { confirmAndDeleteFromDisk, diskTrashAvailable } from "./delete-from-disk";
import { isNativeFS } from "@/project/native-fs";
import { reimportPhotos } from "./import-photos";
import { getSettings } from "@/state/settings-store";
import { loadSavedEdit } from "@/catalog/edit-params";
import { pasteSettings } from "@/catalog/paste-settings";
import { useDevelopClipboard } from "@/state/develop-clipboard";

export interface PhotoActions {
  /** Right-click handler for a photo cell. Right-clicking a photo that's part
   *  of the current selection targets the whole selection; right-clicking an
   *  unselected one selects just it first (mirrors the drag behavior). */
  onContextMenu: (id: string, e: React.MouseEvent) => void;
  /** The menu and its dialogs. Render them inside the surface. */
  overlays: ReactNode;
}

// F2 asks for a rename by event, since the surface owns the dialog. Only the
// most recently mounted surface answers, so a Filmstrip open beside the grid
// raises one dialog, not two.
const renameOwners: symbol[] = [];

export function usePhotoActions(): PhotoActions {
  const photos = useCatalogStore((s) => s.photos);
  const select = useCatalogStore((s) => s.select);
  const rotatePhotos = useCatalogStore((s) => s.rotatePhotos);
  const removePhotos = useCatalogStore((s) => s.removePhotos);
  const setActivePhoto = useCatalogStore((s) => s.setActivePhoto);
  const setActiveModule = useUIStore((s) => s.setActiveModule);
  const clipboard = useDevelopClipboard((s) => s.clipboard);
  const setClipboard = useDevelopClipboard((s) => s.copy);
  const gridMenuItems = useGridMenuItems();

  // The targeted ids are captured when the menu opens so later actions don't
  // depend on the live selection.
  const [menu, setMenu] = useState<{ x: number; y: number; ids: string[] } | null>(null);
  const onContextMenu = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.preventDefault();
      const sel = useCatalogStore.getState().selectedIds;
      let ids: string[];
      if (sel.has(id)) {
        ids = [...sel];
      } else {
        select(id);
        ids = [id];
      }
      setMenu({ x: e.clientX, y: e.clientY, ids });
    },
    [select],
  );

  const handleExportData = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    const n = await exportPhotoData(ids);
    window.alert(
      `Wrote ${n} sidecar file${n === 1 ? "" : "s"} (“<name>.safelight.json”) next to the selected photo${ids.length === 1 ? "" : "s"}. Move the photos with their sidecars and the next project to scan them will pick up the ratings, labels and edits.`,
    );
  }, []);

  // Rename the targeted photo's file on disk (in place, extension preserved).
  // Only offered for a single photo; opens a small dialog, then renames.
  const [renameTarget, setRenameTarget] = useState<{
    id: string;
    filename: string;
    copyName: string;
    isCopy: boolean;
  } | null>(null);

  // Names the rename dialog must refuse. A master competes with the other real
  // files in its folder (virtual copies mirror a master's filename, so counting
  // them would flag the master's own name); a copy competes with its siblings'
  // distinguishers.
  const takenRenameNames = useMemo(() => {
    if (!renameTarget) return [];
    const target = photos.find((p) => p.id === renameTarget.id);
    if (!target) return [];
    const siblings = photos.filter((p) => p.id !== target.id);
    return renameTarget.isCopy
      ? siblings
          .filter((p) => p.copyOf === target.copyOf)
          .map((p) => p.copyName ?? "")
      : siblings
          .filter((p) => !p.copyOf && p.folder === target.folder)
          .map((p) => splitFilename(p.filename)[0]);
  }, [photos, renameTarget]);

  // A virtual copy shares its master's file, so "renaming" it edits the display
  // distinguisher (copyName); a master renames the actual file on disk.
  const handleRename = useCallback(
    async (target: { id: string; isCopy: boolean }, value: string) => {
      setRenameTarget(null);
      if (target.isCopy) {
        await useCatalogStore.getState().setCopyName(target.id, value);
        return;
      }
      const res = await renamePhoto(target.id, value);
      if (!res.ok) window.alert(res.reason);
    },
    [],
  );

  const openRename = useCallback((id: string) => {
    const p = useCatalogStore.getState().photos.find((x) => x.id === id);
    if (p)
      setRenameTarget({
        id: p.id,
        filename: p.filename,
        copyName: p.copyName ?? "copy",
        isCopy: !!p.copyOf,
      });
  }, []);

  const ownerToken = useRef<symbol | null>(null);
  ownerToken.current ??= Symbol("photo-surface");
  useEffect(() => {
    const token = ownerToken.current!;
    renameOwners.push(token);
    const handler = (e: Event) => {
      if (renameOwners[renameOwners.length - 1] !== token) return;
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      if (id) openRename(id);
    };
    window.addEventListener("sl-rename-photo", handler);
    return () => {
      window.removeEventListener("sl-rename-photo", handler);
      const i = renameOwners.lastIndexOf(token);
      if (i >= 0) renameOwners.splice(i, 1);
    };
  }, [openRename]);

  // Reveal the photo's file in the OS file manager. Single-photo only (native
  // builds), mirroring the platform "show this file in its folder" action.
  const handleReveal = useCallback(async (id: string) => {
    const ok = await revealPhoto(id);
    if (!ok) window.alert("Couldn't open the folder — the file may have moved or been deleted.");
  }, []);

  // Re-read the targeted photos from disk: rebuild their previews, refresh
  // metadata, and invalidate the develop cache. Ratings/labels/edits are kept.
  // Cells refresh live as each completes; only a failure raises an alert.
  const handleReimport = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const targets = useCatalogStore.getState().photos.filter((p) => idSet.has(p.id));
    const { ok, failed } = await reimportPhotos(
      targets,
      undefined,
      (p) => useCatalogStore.getState().updatePhoto(p),
    );
    if (failed > 0) {
      window.alert(
        `Re-imported ${ok} photo${ok === 1 ? "" : "s"}. ${failed} couldn't be read or decoded from disk.`,
      );
    }
  }, []);

  const handleRemove = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      if (getSettings().confirmRemovePhotos) {
        const ok = window.confirm(
          `Remove ${ids.length} photo${ids.length === 1 ? "" : "s"} from the catalog? The original file${ids.length === 1 ? "" : "s"} on disk won't be deleted (they'll reappear on the next folder scan).`,
        );
        if (!ok) return;
      }
      removePhotos(ids);
    },
    [removePhotos],
  );

  // Copy/paste develop settings. Copy reads one photo's saved edit and opens the
  // checklist dialog; paste merges the clipboard's chosen adjustments onto every
  // targeted photo (see paste-settings).
  const [copyDialog, setCopyDialog] = useState<{
    params: DevelopParams;
    paramBag: Record<string, unknown>;
    sourceName: string;
  } | null>(null);

  const handleCopySettings = useCallback(async (id: string) => {
    const photo = useCatalogStore.getState().photos.find((p) => p.id === id);
    if (!photo) return;
    const { params, paramBag } = await loadSavedEdit(id, photo.exif.colorTemperature);
    setCopyDialog({ params, paramBag, sourceName: photo.filename });
  }, []);

  const handlePasteSettings = useCallback(async (ids: string[]) => {
    const clip = useDevelopClipboard.getState().clipboard;
    if (!clip) return;
    await pasteSettings(ids, clip);
  }, []);

  const menuItems = useMemo<ContextMenuEntry[]>(() => {
    if (!menu) return [];
    const { ids } = menu;
    const n = ids.length;
    const suffix = n > 1 ? ` (${n})` : "";
    return [
      {
        label: "Open in Develop",
        disabled: n !== 1,
        onClick: () => {
          setActivePhoto(ids[0]);
          setActiveModule("develop");
        },
      },
      {
        label: "Rename…",
        disabled: n !== 1,
        onClick: () => openRename(ids[0]),
      },
      {
        label: "Show in folder",
        disabled: n !== 1 || !isNativeFS(),
        onClick: () => void handleReveal(ids[0]),
      },
      "separator",
      {
        label: "Copy settings…",
        disabled: n !== 1,
        onClick: () => void handleCopySettings(ids[0]),
      },
      {
        label: clipboard
          ? `Paste settings${suffix}`
          : "Paste settings (nothing copied)",
        disabled: !clipboard,
        onClick: () => void handlePasteSettings(ids),
      },
      "separator",
      { label: `Rotate clockwise${suffix}`, onClick: () => rotatePhotos(ids, 90) },
      {
        label: `Rotate counter-clockwise${suffix}`,
        onClick: () => rotatePhotos(ids, -90),
      },
      "separator",
      { label: `Re-import${suffix}`, onClick: () => void handleReimport(ids) },
      { label: `Export data…${suffix}`, onClick: () => void handleExportData(ids) },
      "separator",
      { label: `Remove${suffix}`, danger: true, onClick: () => handleRemove(ids) },
      // Files go to the OS trash, so this stays recoverable; unavailable in
      // the plain-browser build, which has no path-level fs access.
      ...(diskTrashAvailable()
        ? [
            {
              label: `Delete from disk…${suffix}`,
              danger: true,
              onClick: () => void confirmAndDeleteFromDisk(ids),
            } satisfies ContextMenuEntry,
          ]
        : []),
      // Extension-contributed actions (e.g. "Create virtual copy"), grouped
      // below the built-ins behind a separator.
      ...(gridMenuItems.length > 0
        ? [
            "separator" as const,
            ...gridMenuItems.map((item): ContextMenuEntry => ({
              label:
                typeof item.label === "function" ? item.label(ids) : item.label,
              danger: item.danger,
              disabled: item.enabled ? !item.enabled(ids) : false,
              onClick: () => item.onClick(ids),
            })),
          ]
        : []),
    ];
  }, [
    menu,
    clipboard,
    gridMenuItems,
    openRename,
    handleCopySettings,
    handlePasteSettings,
    rotatePhotos,
    handleReveal,
    handleReimport,
    handleExportData,
    handleRemove,
    setActivePhoto,
    setActiveModule,
  ]);

  const overlays = (
    <>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
      {copyDialog && (
        <CopySettingsDialog
          params={copyDialog.params}
          paramBag={copyDialog.paramBag}
          sourceName={copyDialog.sourceName}
          onCopy={(clip) => {
            setClipboard(clip);
            setCopyDialog(null);
          }}
          onCancel={() => setCopyDialog(null)}
        />
      )}
      {renameTarget &&
        (renameTarget.isCopy ? (
          <RenamePhotoDialog
            title="Rename copy"
            value={renameTarget.copyName}
            prefix={`${splitFilename(renameTarget.filename)[0]}_`}
            suffix={splitFilename(renameTarget.filename)[1]}
            placeholder="copy"
            takenNames={takenRenameNames}
            onSubmit={(v) =>
              void handleRename({ id: renameTarget.id, isCopy: true }, v)
            }
            onCancel={() => setRenameTarget(null)}
          />
        ) : (
          <RenamePhotoDialog
            title="Rename photo"
            value={splitFilename(renameTarget.filename)[0]}
            suffix={splitFilename(renameTarget.filename)[1]}
            placeholder="File name"
            takenNames={takenRenameNames}
            onSubmit={(v) =>
              void handleRename({ id: renameTarget.id, isCopy: false }, v)
            }
            onCancel={() => setRenameTarget(null)}
          />
        ))}
    </>
  );

  return { onContextMenu, overlays };
}
