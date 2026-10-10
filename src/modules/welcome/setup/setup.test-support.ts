// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Fixtures for the welcome setup's tests: a kits.json with two overlapping
// kits, a trust list that verifies them, and a stub of the Electron bridge
// whose methods are spies each test can re-program.

import { vi, type Mock } from "vitest";
import type { ExtensionManifest, TrustList } from "@/extensions/types";

export const ONE = "acme/one";
export const TWO = "acme/two";
export const THREE = "acme/three";

export const KITS_DOC = {
  schema: 1,
  kits: [
    {
      id: "film",
      name: "Film looks",
      description: "Film stock simulation.",
      icon: "film",
      extensions: [
        { repo: "Acme/One", name: "One", summary: "First thing." },
        { repo: TWO, name: "Two", summary: "Second thing." },
      ],
    },
    {
      id: "colour",
      name: "Colour work",
      description: "Colour tools.",
      icon: "palette",
      extensions: [
        { repo: TWO, name: "Two", summary: "Second thing." },
        { repo: THREE, name: "Three", summary: "Third thing." },
      ],
    },
  ],
};

export const EMPTY_TRUST: TrustList = {
  verified: [],
  reviewed: {},
  repos: [],
  owners: [],
  reason: {},
};

export const trustList = (patch: Partial<TrustList> = {}): TrustList => ({
  ...EMPTY_TRUST,
  verified: [ONE, TWO, THREE],
  ...patch,
});

export const manifestFor = (
  repo: string,
  extra: Partial<ExtensionManifest> = {},
): ExtensionManifest => ({
  id: repo.replace("/", "."),
  name: repo.split("/")[1],
  version: "1.0.0",
  main: "index.js",
  ...extra,
});

export interface FakeBridge {
  list: Mock<() => Promise<ExtensionManifest[]>>;
  install: Mock<(spec: string) => Promise<ExtensionManifest>>;
  uninstall: Mock<(id: string) => Promise<void>>;
  settleUpdate: Mock<(id: string, outcome: string) => Promise<ExtensionManifest | null>>;
  kits: Mock<(force?: boolean) => Promise<unknown>>;
  trustList: Mock<(force?: boolean) => Promise<TrustList>>;
  remoteManifest: Mock<(repo: string) => Promise<{ version: string } | null>>;
}

export function stubBridge(): FakeBridge {
  const bridge: FakeBridge = {
    list: vi.fn<() => Promise<ExtensionManifest[]>>(async () => []),
    install: vi.fn<(spec: string) => Promise<ExtensionManifest>>(async (spec) =>
      manifestFor(spec),
    ),
    uninstall: vi.fn<(id: string) => Promise<void>>(async () => {}),
    settleUpdate: vi.fn<
      (id: string, outcome: string) => Promise<ExtensionManifest | null>
    >(async () => null),
    kits: vi.fn<(force?: boolean) => Promise<unknown>>(async () => KITS_DOC),
    trustList: vi.fn<(force?: boolean) => Promise<TrustList>>(async () =>
      trustList(),
    ),
    remoteManifest: vi.fn<(repo: string) => Promise<{ version: string } | null>>(
      async () => ({ version: "1.0.0" }),
    ),
  };
  vi.stubGlobal("safelightNative", { plugins: bridge });
  return bridge;
}
