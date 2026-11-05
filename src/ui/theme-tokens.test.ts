// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A var(--color-…) that no theme declares resolves to nothing, so the text it
// colours silently falls back to the inherited colour under every theme and
// overlay. The core dialogues and menus may only name tokens index.css declares.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(`${SRC}/${rel}`, "utf8");

const declared = new Set(
  [...read("index.css").matchAll(/(--color-[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
);

const FILES = [
  "modules/library/CopySettingsDialog.tsx",
  "modules/library/RenamePhotoDialog.tsx",
  "ui/components/ConfirmDialog.tsx",
  "ui/components/ContextMenu.tsx",
  "ui/components/Dialog.tsx",
];

describe("theme tokens in the core dialogues and menus", () => {
  it.each(FILES)("%s names only declared colour tokens", (rel) => {
    const used = [...read(rel).matchAll(/var\((--color-[a-z0-9-]+)/g)].map((m) => m[1]);
    expect(used.filter((name) => !declared.has(name))).toEqual([]);
  });
});
