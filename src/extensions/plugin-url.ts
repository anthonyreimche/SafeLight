// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Where app:// serves an extension's files: /__plugins__/<id>/ is its folder,
// installed or in the Developer Tools dev folder (electron/app-protocol.cjs).
// The version is a cache-buster: the renderer caches a dynamic import() by
// URL, so without it an updated extension keeps the module imported at
// launch.

export function pluginFileUrl(origin: string, id: string, path: string, version?: string): string {
  const file = path
    .replace(/^\/+/, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const query = version ? `?v=${encodeURIComponent(version)}` : "";
  return `${origin}/__plugins__/${id}/${file}${query}`;
}
