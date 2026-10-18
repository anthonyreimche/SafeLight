# Safelight logo

The logo is drawn in `art/icon.ai`. Two of its artboards are the masters here,
exported as SVG on a 512 x 512 viewBox:

| File | Artboard | Use |
| --- | --- | --- |
| `safelight-stamp.svg` | 6, round badge | App icon and favicons |
| `safelight-logo.svg` | 7, sticker | Landing site logo, README banner, social preview, installer header |

To change the logo, re-export the artboard over its master, then run, from the
repo root:

    npm i --no-save opentype.js
    node art/logo/build-logo.cjs

It writes `banner.svg`, `installer-header.svg` and `installer-sidebar.svg`
here, and overwrites `public/favicon.svg`, `site/favicon.svg` and
`art/favicon.svg` (the stamp), `site/logo.svg` (the sticker cropped to its
outline), `art/Banner.png` and `site/shots/og-cover.jpg`. Then `npm run icon`
rebuilds `build/icon.*` and the installer bitmaps. opentype.js is only for the
installer sidebar's card titles, set in Afacad Bold (`source/Afacad-Bold.ttf`,
SIL Open Font License 1.1, `source/OFL.txt`).

## Icon

The stamp at every size: `npm run icon` draws each `.ico` size (16 to 256 px)
and the 1024 px `icon.png` from `public/favicon.svg` at that size. Below 48 px
the script can't be read; the red bulb on the dark disc is what carries it.

## Logo

The sticker, cropped to its black outline. On the landing site it is 64 px tall
in the nav (52 px on phones) and 112 px in the footer.

## Colours

| Name | Hex |
| --- | --- |
| Safelight red | `#f3223f` |
| Darkroom | `#0f0b0b` |
| Paper | `#f7f3ee` |

## Installer artwork

The Windows installer uses the landing site's print look (paper `#f3ece0`,
ink `#16110f`, red `#e5172f`):

- `installer-sidebar.svg` (164 x 340): the site hero's Tone curve and
  Histogram cards, for the welcome and finish pages.
- `installer-header.svg` (150 x 57): the sticker, 47 px tall, right-aligned,
  for the inner pages.

`npm run icon` rasterises both at 100, 125, 150, 175, 200, 250 and 300 % into
`build/installer/`, and `build/installer.nsh` loads the one for the display's
scaling, so the art is never resampled.

The installer's text is set in its own copy of Afacad
(`build/installer-font/`, "Afacad Setup", line spacing tightened to fit
Windows' control heights), written by `python art/logo/installer-font.py`
(fontTools) when Afacad changes.
