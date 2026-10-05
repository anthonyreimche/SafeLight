# Safelight — founded and principally authored by Anthony Reimche.
# Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
# attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
# be preserved in derived versions.

# Writes the Windows installer's copy of Afacad (build/installer-font/):
# static Regular and Bold instances of public/fonts/afacad/Afacad[wght].ttf,
# with the line box tightened from 1.333 to 1.139 em so text fits the height
# Windows gives each installer control, and the family renamed "Afacad Setup"
# so an Afacad the user installed is never picked instead. Afacad's OFL has
# no Reserved Font Name. Run from the repo root when Afacad changes:
#
#   pip install fonttools
#   python art/logo/installer-font.py

import shutil
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "public" / "fonts" / "afacad"
OUT = ROOT / "build" / "installer-font"
FAMILY = "Afacad Setup"
ASCENT, DESCENT = 1260, 380

OUT.mkdir(parents=True, exist_ok=True)
for style, weight in (("Regular", 400), ("Bold", 700)):
    font = instantiateVariableFont(TTFont(SOURCE / "Afacad[wght].ttf"), {"wght": weight}, updateFontNames=True)
    os2, hhea = font["OS/2"], font["hhea"]
    os2.usWinAscent, os2.usWinDescent = ASCENT, DESCENT
    os2.sTypoAscender, os2.sTypoDescender, os2.sTypoLineGap = ASCENT, -DESCENT, 0
    hhea.ascent, hhea.descent, hhea.lineGap = ASCENT, -DESCENT, 0
    for record in font["name"].names:
        if record.nameID in (1, 16):
            record.string = FAMILY
        elif record.nameID == 4:
            record.string = f"{FAMILY} {style}"
        elif record.nameID == 6:
            record.string = f"AfacadSetup-{style}"
    font.save(OUT / f"AfacadSetup-{style}.ttf")
shutil.copyfile(SOURCE / "OFL.txt", OUT / "OFL.txt")
print(f"installer font written to {OUT}")
