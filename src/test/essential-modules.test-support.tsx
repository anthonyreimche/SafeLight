// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Library and Develop as their official extensions register them, for tests of
// a window that has them installed. The views are stand-ins: Library's status
// bar counts the catalog as the real one does.

import { registerModule, unregisterExtension } from "@/extensions/registry";
import { useCatalogStore } from "@/state/catalog-store";

function LibraryStatusBar() {
  const count = useCatalogStore((s) => s.photos.length);
  return (
    <span>
      {count} photo{count !== 1 && "s"} in catalog
    </span>
  );
}

export function registerEssentialModules(): void {
  registerModule("safelight.library", {
    id: "library",
    label: "Library",
    component: () => <p>library view</p>,
    statusBar: LibraryStatusBar,
  });
  registerModule("safelight.develop", {
    id: "develop",
    label: "Develop",
    component: () => <p>develop view</p>,
  });
}

export function unregisterEssentialModules(): void {
  unregisterExtension("safelight.library");
  unregisterExtension("safelight.develop");
}
