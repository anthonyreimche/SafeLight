// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The library-source members of api.library (src/project/library-sources.ts):
// registering a source, listing the registered ones, opening one as the
// project, and the originals its catalogue keeps.

import { useMemo } from "react";
import type { SafelightAPI } from "./api/scoped-api";
import {
  DEFAULT_KEPT_ORIGINALS_LIMIT,
  clearKeptOriginals,
  keptOriginalsUsage,
  listLibrarySources,
  registerLibrarySource,
  sourceRefOf,
  sourceRoot,
  trimKeptOriginals,
  unregisterLibrarySource,
  useLibrarySourceMap,
  type LibrarySourceRef,
} from "@/project/library-sources";
import { useProjectStore } from "@/project/project-store";
import { resolveWorkingDir } from "@/project/working-dir";

type SourceMembers = Pick<
  SafelightAPI["library"],
  | "registerSource"
  | "unregisterSource"
  | "useSources"
  | "openSource"
  | "useOpenSource"
  | "keptOriginals"
  | "clearKeptOriginals"
>;

/** A source's limit on kept originals in bytes; Infinity for none. */
const limitOf = (limit: number | null | undefined): number =>
  limit === undefined ? DEFAULT_KEPT_ORIGINALS_LIMIT : (limit ?? Infinity);

/** The catalogue folder of source `id` as registered now, which must be
 *  `extensionId`'s own. */
async function ownCatalogue(
  extensionId: string,
  id: string,
): Promise<{ ref: LibrarySourceRef; sl: FileSystemDirectoryHandle }> {
  const root = sourceRoot(id);
  const ref = sourceRefOf(root);
  if (!root || ref?.extensionId !== extensionId) throw new Error(`“${id}” isn't a source this extension registered`);
  return { ref, sl: (await resolveWorkingDir(root)).sl };
}

export function librarySourcesAPI(extensionId: string): SourceMembers {
  // A lowered limit's trim, which keptOriginals waits for so the space it tells
  // is the space left.
  let trimmed: Promise<void> = Promise.resolve();
  return {
    registerSource: (source) => {
      const own = (s: { id: string; extensionId: string }) => s.id === source.id && s.extensionId === extensionId;
      const was = listLibrarySources().find(own);
      const before = registerLibrarySource(extensionId, source);
      const now = listLibrarySources().find(own);
      if (was && now && limitOf(now.keptOriginalsLimit) < limitOf(was.keptOriginalsLimit)) {
        const trim = ownCatalogue(extensionId, source.id)
          .then(({ ref, sl }) => trimKeptOriginals(ref, sl, limitOf(now.keptOriginalsLimit)))
          .catch((e: unknown) => console.warn(`[sources] the originals kept for “${source.name}” weren't trimmed:`, e));
        trimmed = trimmed.then(() => trim);
      }
      if (before === null) return;
      // The open project shows the library the source no longer does.
      const open = sourceRefOf(useProjectStore.getState().root);
      if (open?.id === source.id && open.library === before) useProjectStore.getState().closeProject();
    },
    unregisterSource: (id) => {
      const open = sourceRefOf(useProjectStore.getState().root);
      unregisterLibrarySource(extensionId, id);
      // Signed out: the project closes rather than show a source nobody serves.
      if (open?.id === id && open.extensionId === extensionId) useProjectStore.getState().closeProject();
    },
    useSources: () => {
      const sources = useLibrarySourceMap();
      const root = useProjectStore((s) => s.root);
      return useMemo(() => {
        const openId = sourceRefOf(root)?.id;
        return Object.values(sources).map((s) => ({
          id: s.id,
          name: s.name,
          extensionId: s.extensionId,
          open: s.id === openId,
        }));
      }, [sources, root]);
    },
    openSource: async (id) => {
      const root = sourceRoot(id);
      if (root) await useProjectStore.getState().openProject(root);
    },
    useOpenSource: () => {
      const root = useProjectStore((s) => s.root);
      return useMemo(() => {
        const ref = sourceRefOf(root);
        return ref ? { id: ref.id, name: ref.name } : null;
      }, [root]);
    },
    keptOriginals: async (id) => {
      await trimmed;
      return keptOriginalsUsage((await ownCatalogue(extensionId, id)).sl);
    },
    clearKeptOriginals: async (id) => {
      const { ref, sl } = await ownCatalogue(extensionId, id);
      return clearKeptOriginals(ref, sl);
    },
  };
}
