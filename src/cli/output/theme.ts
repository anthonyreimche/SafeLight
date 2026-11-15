// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Colour as tokens. A component names a token, never a colour; the token
// resolves through the background (dark, light, or not known) and the colour
// tier the terminal has. Body text is always the terminal's own foreground,
// and nothing here paints a background except the two pills.

export type ThemeName = "dark" | "light" | "unknown";
/** "tagged" writes ‹amber›text‹/› in place of escape codes, so golden tests read like the mockups. */
export type ColourTier = "truecolour" | "256" | "16" | "mono" | "tagged";

export type ColourToken =
  | "muted" | "faint" | "lamp" | "bulb" | "lampShade" | "ember" | "amber" | "amberDim" | "ok" | "star"
  | "label.red" | "label.yellow" | "label.green" | "label.blue" | "label.purple";

export type TokenName =
  | "text" | "strong" | ColourToken
  /** Words that aren't Safelight's: presets, quoted text, <placeholders>. */
  | "italic"
  /** Something that resolves: a photo that exists, a link. */
  | "path"
  /** A token that can't be right: lamp, with a curly underline where the terminal has one. */
  | "invalid"
  /** A value past its range: amber, underlined. */
  | "past"
  | "pill.lamp" | "pill.amber";

export type Rgb = readonly [number, number, number];

export interface Theme {
  readonly tier: ColourTier;
  readonly name: ThemeName;
  paint(token: TokenName, text: string): string;
  /** A colour between two tokens, 0 at `from` and 1 at `to`: smooth in 24-bit, three steps in 256, `to` below that. */
  blend(from: ColourToken, to: ColourToken, t: number, text: string): string;
  /** Any colour, where 24-bit colour reaches the screen; `fallback` everywhere else. */
  rgb(colour: Rgb, text: string, fallback: TokenName): string;
  /** The 24-bit colour a token stands for on this background. */
  colourOf(token: ColourToken): Rgb;
  /** An OSC 8 link where the terminal follows them; the text alone otherwise. */
  link(url: string, text: string): string;
}

const FAINT = "faint";

interface Ink {
  dark: string;
  light: string;
  /** 256-colour index on dark, on light, and where the background isn't known ("dark" = the dark column). */
  on256: readonly [dark: number, light: number, unknown: number | typeof FAINT | "dark"];
  on16: number | typeof FAINT;
  /** Adds SGR 2 where the background isn't known and in 16 colours. */
  dimmed?: boolean;
}

const INKS: Record<ColourToken, Ink> = {
  muted: { dark: "#a89f98", light: "#6f655e", on256: [246, 242, FAINT], on16: FAINT },
  faint: { dark: "#5c514b", light: "#c9bfb5", on256: [240, 250, FAINT], on16: FAINT },
  lamp: { dark: "#f3223f", light: "#d81b36", on256: [197, 161, 197], on16: 31 },
  // The bulb is the logo, so it keeps its own red on paper too.
  bulb: { dark: "#f3223f", light: "#f3223f", on256: [197, 197, "dark"], on16: 91 },
  lampShade: { dark: "#c41a32", light: "#a51228", on256: [161, 124, 161], on16: 31 },
  ember: { dark: "#5a0c18", light: "#f0b8c0", on256: [52, 217, 88], on16: 31 },
  amber: { dark: "#f5a524", light: "#a85a00", on256: [214, 130, 166], on16: 33 },
  amberDim: { dark: "#9a6a1f", light: "#d9a25a", on256: [136, 179, 166], on16: 33, dimmed: true },
  ok: { dark: "#8fbf8f", light: "#2f7d4f", on256: [108, 29, 65], on16: 32 },
  star: { dark: "#f5c542", light: "#a85a00", on256: [221, 130, 166], on16: 33 },
  "label.red": { dark: "#e74c3c", light: "#e74c3c", on256: [167, 167, 167], on16: 31 },
  "label.yellow": { dark: "#f39c12", light: "#f39c12", on256: [214, 214, 214], on16: 33 },
  "label.green": { dark: "#27ae60", light: "#27ae60", on256: [35, 35, 35], on16: 32 },
  "label.blue": { dark: "#3498db", light: "#3498db", on256: [74, 74, 74], on16: 34 },
  "label.purple": { dark: "#9b59b6", light: "#9b59b6", on256: [134, 134, 134], on16: 35 },
};

export function hexRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

export function mixRgb(from: Rgb, to: Rgb, t: number): Rgb {
  const at = Math.min(1, Math.max(0, t));
  return [0, 1, 2].map((i) => Math.round(from[i] + (to[i] - from[i]) * at)) as unknown as Rgb;
}

/** The nearest colour of the 6×6×6 cube every 256-colour terminal has. */
export function cubeIndex([r, g, b]: Rgb): number {
  const step = (v: number): number => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  return 16 + 36 * step(r) + 6 * step(g) + step(b);
}

/** Relative luminance, 0…1, of an sRGB colour. */
export function luminance([r, g, b]: Rgb): number {
  const linear = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

interface Code { open: string; close: string }

const NONE: Code = { open: "", close: "" };
const wrap = (code: Code, text: string): string =>
  text === "" || code.open === "" ? text : `\x1b[${code.open}m${text}\x1b[${code.close}m`;
const both = (a: Code, b: Code): Code => ({
  open: [a.open, b.open].filter((part) => part !== "").join(";"),
  close: [a.close, b.close].filter((part) => part !== "").join(";"),
});

const BOLD: Code = { open: "1", close: "22" };
const DIM: Code = { open: "2", close: "22" };
const ITALIC: Code = { open: "3", close: "23" };
const UNDERLINE: Code = { open: "4", close: "24" };
const REVERSE: Code = { open: "7", close: "27" };
const fg = (params: string): Code => ({ open: params, close: "39" });
const fgRgb = ([r, g, b]: Rgb): Code => fg(`38;2;${r};${g};${b}`);
const fg256 = (index: number): Code => fg(`38;5;${index}`);

export interface ThemeOptions {
  tier: ColourTier;
  name: ThemeName;
  /** The terminal draws SGR 4:3 and takes an underline colour. */
  curly?: boolean;
  links?: boolean;
}

function tagged(name: ThemeName): Theme {
  const paint = (token: TokenName, text: string): string => (text === "" || token === "text" ? text : `‹${token}›${text}‹/›`);
  return {
    tier: "tagged",
    name,
    paint,
    blend: (_from, to, _t, text) => paint(to, text),
    rgb: (_colour, text, fallback) => paint(fallback, text),
    colourOf: (token) => hexRgb(INKS[token].dark),
    link: (_url, text) => text,
  };
}

export function createTheme(options: ThemeOptions): Theme {
  const { tier, name } = options;
  if (tier === "tagged") return tagged(name);

  const colourOf = (token: ColourToken): Rgb => hexRgb(name === "light" ? INKS[token].light : INKS[token].dark);

  const ink = (token: ColourToken): Code => {
    const spec = INKS[token];
    if (tier === "mono") return token === "muted" || token === "faint" ? DIM : NONE;
    if (tier === "16") {
      if (spec.on16 === FAINT) return DIM;
      return spec.dimmed ? both(DIM, fg(String(spec.on16))) : fg(String(spec.on16));
    }
    const [dark, light, unknown] = spec.on256;
    if (name === "unknown" && unknown !== "dark") {
      if (unknown === FAINT) return DIM;
      return spec.dimmed ? both(DIM, fg256(unknown)) : fg256(unknown);
    }
    if (tier === "truecolour") return fgRgb(colourOf(token));
    return fg256(name === "light" ? light : dark);
  };

  const pill = (token: ColourToken, on: Rgb, on256: number, on16: number): Code => {
    if (tier === "mono") return both(BOLD, REVERSE);
    const background = ink(token).open.replace(/^38/, "48").replace(/^3(\d)$/, "4$1").replace(/^9(\d)$/, "10$1");
    const text = tier === "truecolour" ? fgRgb(on).open : tier === "256" ? fg256(on256).open : String(on16);
    return { open: `1;${background};${text}`, close: "22;49;39" };
  };

  const invalid = (): Code => {
    if (tier === "mono") return UNDERLINE;
    if (!options.curly) return ink("lamp");
    const [r, g, b] = colourOf("lamp");
    const colour = tier === "truecolour" ? `58:2::${r}:${g}:${b}` : "58:5:197";
    return both(ink("lamp"), { open: `4:3;${colour}`, close: "24;59" });
  };

  const codes: Record<TokenName, Code> = {
    text: NONE,
    strong: BOLD,
    italic: ITALIC,
    path: UNDERLINE,
    invalid: invalid(),
    past: both(ink("amber"), UNDERLINE),
    "pill.lamp": pill("lamp", [255, 255, 255], 231, 97),
    "pill.amber": pill("amber", [15, 11, 11], 16, 30),
    ...(Object.fromEntries((Object.keys(INKS) as ColourToken[]).map((token) => [token, ink(token)])) as Record<ColourToken, Code>),
  };

  const flat = tier === "mono" || tier === "16";

  return {
    tier,
    name,
    paint: (token, text) => wrap(codes[token], text),
    blend(from, to, t, text) {
      if (flat) return wrap(codes[to], text);
      if (tier === "truecolour" && name !== "unknown") return wrap(fgRgb(mixRgb(colourOf(from), colourOf(to), t)), text);
      if (t < 1 / 3) return wrap(codes[from], text);
      if (t > 2 / 3) return wrap(codes[to], text);
      return wrap(fg256(cubeIndex(mixRgb(colourOf(from), colourOf(to), 0.5))), text);
    },
    rgb: (colour, text, fallback) => wrap(tier === "truecolour" ? fgRgb(colour) : codes[fallback], text),
    colourOf,
    link: (url, text) => (options.links && text !== "" ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : text),
  };
}
