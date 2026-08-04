// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Shared decode guard for the in-house image decoders (Netpbm, TIFF). A corrupt
// header can claim absurd dimensions; reject anything above this pixel count
// before allocating so a bad file can't exhaust memory. 2^28 = 16384² px.
export const MAX_DECODE_PIXELS = 268_435_456;
