// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A thumbnail for one cell of the contact sheet. From pixels it is half
// blocks: two pixels a cell, the upper one the foreground and the lower one
// the background. From a JPEG it is the file itself, for iTerm2 to draw.

import type { Look } from "../look";
import { cubeIndex } from "../theme";
import type { ItermPicture } from "../types";

export interface Pixels { width: number; height: number; rgba: Uint8Array }

/** A terminal cell is about twice as tall as it is wide. */
const CELL_ASPECT = 2;

/** The cells a picture of this shape takes inside a box, at least one each way. */
export function fitCells(width: number, height: number, columns: number, rows: number): { columns: number; rows: number } {
  const shape = width > 0 && height > 0 ? height / width : 2 / 3;
  const tall = (columns * shape) / CELL_ASPECT;
  if (tall <= rows) return { columns, rows: Math.max(1, Math.round(tall)) };
  return { columns: Math.max(1, Math.min(columns, Math.round((rows * CELL_ASPECT) / shape))), rows };
}

/** The mean colour of each cell of a `columns` × `rows` grid laid over the image. */
function sample(image: Pixels, columns: number, rows: number): Uint8Array {
  const out = new Uint8Array(columns * rows * 3);
  for (let y = 0; y < rows; y++) {
    const top = Math.floor((y * image.height) / rows);
    const bottom = Math.max(top + 1, Math.floor(((y + 1) * image.height) / rows));
    for (let x = 0; x < columns; x++) {
      const left = Math.floor((x * image.width) / columns);
      const right = Math.max(left + 1, Math.floor(((x + 1) * image.width) / columns));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let py = top; py < bottom; py++) {
        for (let px = left; px < right; px++) {
          const at = (py * image.width + px) * 4;
          r += image.rgba[at];
          g += image.rgba[at + 1];
          b += image.rgba[at + 2];
        }
      }
      const count = (bottom - top) * (right - left);
      out.set([Math.round(r / count), Math.round(g / count), Math.round(b / count)], (y * columns + x) * 3);
    }
  }
  return out;
}

/**
 * The image as lines of half blocks no larger than `columns` × `rows` cells,
 * centred in the columns. Null where the terminal has neither 24-bit colour
 * nor the 256-colour cube, since blocks in 16 colours aren't a picture.
 */
export function blockPicture(image: Pixels, columns: number, rows: number, look: Look): string[] | null {
  const { tier } = look.theme;
  if (tier !== "truecolour" && tier !== "256" && tier !== "tagged") return null;
  if (image.width <= 0 || image.height <= 0 || image.rgba.length < image.width * image.height * 4) return null;
  const size = fitCells(image.width, image.height, columns, rows);
  const pixels = sample(image, size.columns, size.rows * 2);
  const colour = (ground: 38 | 48, at: number): string => {
    const rgb = [pixels[at], pixels[at + 1], pixels[at + 2]] as const;
    return tier === "truecolour" ? `${ground};2;${rgb.join(";")}` : `${ground};5;${cubeIndex(rgb)}`;
  };
  const inset = " ".repeat(Math.floor((columns - size.columns) / 2));
  return Array.from({ length: size.rows }, (_, row) => {
    if (tier === "tagged") return inset + "▀".repeat(size.columns);
    let line = "";
    let last = "";
    for (let x = 0; x < size.columns; x++) {
      const sgr = `${colour(38, (row * 2 * size.columns + x) * 3)};${colour(48, ((row * 2 + 1) * size.columns + x) * 3)}`;
      if (sgr !== last) line += `\x1b[${sgr}m`;
      last = sgr;
      line += "▀";
    }
    return `${inset}${line}\x1b[39;49m`;
  });
}

/** A stored preview for iTerm2, which decodes it. `size` is the photo's, for the rows it takes; a 3:2 frame without. */
export function itermPicture(jpeg: Uint8Array, columns: number, rows: number, size?: { width: number; height: number }): ItermPicture {
  return { jpeg, rows: fitCells(size?.width ?? 3, size?.height ?? 2, columns, rows).rows };
}

export const SAVE_CURSOR = "\x1b7";
export const RESTORE_CURSOR = "\x1b8";

/** Moves right without writing, so nothing already drawn in those cells is wiped. */
export const skipCells = (count: number): string => (count > 0 ? `\x1b[${count}C` : "");

/** Back up `rows` lines, into room made by printing that many blank lines first: a picture drawn on the bottom line would scroll the screen under itself. */
export const climbRows = (rows: number): string => (rows > 0 ? `\x1b[${rows}A` : "");

/** The picture drawn from the cursor into a `columns` × `rows` box, leaving the cursor at the box's right edge on its first row. */
export function itermCell(picture: ItermPicture, columns: number): string {
  const file = `\x1b]1337;File=inline=1;size=${picture.jpeg.length};width=${columns};height=${picture.rows};preserveAspectRatio=1:${Buffer.from(picture.jpeg).toString("base64")}\x07`;
  return SAVE_CURSOR + file + RESTORE_CURSOR + skipCells(columns);
}
