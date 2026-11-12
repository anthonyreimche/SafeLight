// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// api.library's source members: what the Folders panel lists, opening a source
// as the project, and closing a project whose library the source moved off.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { librarySourcesAPI } from "./library-sources-api";
import { dropLibrarySources, sourceRefOf, sourceRoot } from "@/project/library-sources";
import { useProjectStore } from "@/project/project-store";
import type { LibrarySourceContribution } from "./api/sources";

const source = (library = "lib-1"): LibrarySourceContribution => ({
  id: "test.server",
  name: "Server",
  library,
  list: async () => ({}),
  readPreview: async () => new Blob(),
  readOriginal: async () => new Blob(),
});

const real = useProjectStore.getState();
let openProject: ReturnType<typeof vi.fn<(root: FileSystemDirectoryHandle) => Promise<void>>>;
let closeProject: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  openProject = vi.fn(async (root: FileSystemDirectoryHandle) => {
    useProjectStore.setState({ root });
  });
  closeProject = vi.fn(() => useProjectStore.setState({ root: null }));
  useProjectStore.setState({ root: null, openProject, closeProject });
});

afterEach(() => {
  dropLibrarySources("ext.a");
  useProjectStore.setState({ root: null, openProject: real.openProject, closeProject: real.closeProject });
});

describe("api.library sources", () => {
  it("lists the registered sources and which one is open", async () => {
    const api = librarySourcesAPI("ext.a");
    const { result } = renderHook(() => ({ sources: api.useSources(), open: api.useOpenSource() }));
    expect(result.current).toEqual({ sources: [], open: null });

    act(() => api.registerSource(source()));
    expect(result.current.sources).toEqual([{ id: "test.server", name: "Server", extensionId: "ext.a", open: false }]);

    await act(() => api.openSource("test.server"));
    expect(sourceRefOf(openProject.mock.calls[0][0])?.id).toBe("test.server");
    expect(result.current.sources[0].open).toBe(true);
    expect(result.current.open).toEqual({ id: "test.server", name: "Server" });
  });

  it("closes the project when the source moves to another library", () => {
    const api = librarySourcesAPI("ext.a");
    api.registerSource(source("lib-1"));
    useProjectStore.setState({ root: sourceRoot("test.server") });
    api.registerSource(source("lib-1"));
    expect(closeProject).not.toHaveBeenCalled();
    api.registerSource(source("lib-2"));
    expect(closeProject).toHaveBeenCalledTimes(1);
  });

  it("closes the project open on a source its extension unregisters", () => {
    const api = librarySourcesAPI("ext.a");
    api.registerSource(source("lib-1"));
    useProjectStore.setState({ root: sourceRoot("test.server") });
    api.unregisterSource("other");
    expect(closeProject).not.toHaveBeenCalled();
    api.unregisterSource("test.server");
    expect(closeProject).toHaveBeenCalledTimes(1);
  });

  it("opens nothing for a source that isn't registered", async () => {
    await librarySourcesAPI("ext.a").openSource("nope");
    expect(openProject).not.toHaveBeenCalled();
  });
});
