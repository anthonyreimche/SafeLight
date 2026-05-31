import { AppShell } from "@/ui/components/AppShell";
import { LibrarySidebar } from "./LibrarySidebar";
import { LibraryToolbar } from "./LibraryToolbar";
import { LibraryGrid } from "./LibraryGrid";
import { useCatalogStore } from "@/state/catalog-store";
import { useCullingShortcuts } from "./use-culling-shortcuts";

export function LibraryView() {
  const photos = useCatalogStore((s) => s.photos);

  useCullingShortcuts();

  return (
    <AppShell
      leftSidebar={<LibrarySidebar />}
      statusBar={
        <span>
          {photos.length} photo{photos.length !== 1 && "s"} in catalog
        </span>
      }
    >
      <LibraryToolbar />
      <LibraryGrid />
    </AppShell>
  );
}
