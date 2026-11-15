// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Public extension API types. Everything a plugin can see lives here.
// Plugins are prebuilt ESM bundles whose default/named `activate(api)` export
// receives a SafelightAPI scoped to their extension id. The shapes live in
// ./api/*; this barrel keeps `@/extensions/types` the one import path.

export * from "./api/contributions";
export * from "./api/scoped-api";
export * from "./api/store-types";
export * from "./api/native-bridge";
export * from "./api/variables";
export * from "./api/network";
export * from "./api/sockets";
export * from "./api/secrets";
export * from "./api/sources";
