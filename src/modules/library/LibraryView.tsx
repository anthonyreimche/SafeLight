import { AppShell } from "@/ui/components/AppShell";
import { LibraryToolbar } from "./LibraryToolbar";
import { LibrarySubBar } from "./LibrarySubBar";
import { LibraryGrid } from "./LibraryGrid";
import { useCatalogStore } from "@/state/catalog-store";
import { useCullingShortcuts } from "./use-culling-shortcuts";

// The grid is the module's "main" dock panel; Folders/Filters/Info are
// extension panels placed by the library dock layout (see builtin.tsx).
export function LibraryView() {
  const photos = useCatalogStore((s) => s.photos);

  useCullingShortcuts();

  return (
    <AppShell
      module="library"
      statusBar={
        <span>
          {photos.length} photo{photos.length !== 1 && "s"} in catalog
        </span>
      }
    >
      <LibraryToolbar />
      <LibrarySubBar />
      <LibraryGrid />
    </AppShell>
  );
}
