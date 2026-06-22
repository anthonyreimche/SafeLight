// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// `libraw-wasm` ships no type declarations; the adapter narrows the shape it
// uses via its own LibRawCtor type, so a minimal module declaration suffices.
declare module "libraw-wasm" {
  const LibRaw: unknown;
  export default LibRaw;
}
