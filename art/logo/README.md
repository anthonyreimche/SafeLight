# Safelight logo

The logo is drawn in `art/icon.ai`: artboard 3, the sticker, is the one master
here, `safelight-logo.svg`, on a 512 x 512 viewBox. It is the source of the app
icon, the favicons, the landing site logo, the README banner, the social
preview and the installer header. The bulb's grain is a 234 x 301 px raster
inside the artboard, so the logo is sharp at any size except for that texture.

To change the logo, export the artboard over the master and round its path
coordinates to 0.01 (`pdftocairo -svg -f 3 -l 3 art/icon.ai` gives the SVG; the
root's pt size is dropped and a `<title>` added), then run, from the repo root:

    npm i --no-save opentype.js
    node art/logo/build-logo.cjs

It writes `banner.svg`, `installer-header.svg` and `installer-sidebar.svg`
here, and overwrites `public/favicon.svg`, `site/favicon.svg` and
`art/favicon.svg` (the icon), `site/logo.svg` (the sticker cropped to its
outline), `art/Banner.png` and `site/shots/og-cover.jpg`. Then `npm run icon`
rebuilds `build/icon.*` and the installer bitmaps. opentype.js is only for the
installer sidebar's card titles, set in Afacad Bold (`source/Afacad-Bold.ttf`,
SIL Open Font License 1.1, `source/OFL.txt`).

## Icon

The sticker centred on a transparent 512 x 512 square, its longer side at 94%
of the side. `npm run icon` draws each `.ico` size (16 to 256 px) and the
1024 px `icon.png` from `public/favicon.svg` at that size. Below 48 px the
script can't be read; the red bulb in its black outline is what carries it.

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
