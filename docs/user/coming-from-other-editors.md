# Coming from Lightroom or Capture One

If you know Lightroom Classic, Capture One, DxO PhotoLab or darktable, most of Safelight will feel familiar. This page maps the names you know to Safelight's, says what works differently, and lists what Safelight doesn't do yet.

## Two differences to know first

**A project is a folder.** There's no central catalogue. You open a folder, and Safelight keeps its data for that folder in a hidden `.safelight` folder inside it: ratings, edits and previews. This is closer to a Capture One session than a Lightroom catalogue. Your originals are never written to, and copying or moving the folder takes its edits along.

**Most tools are extensions.** Library, Develop, Basic, White Balance, Tone Curve, HSL, Crop, Masking, Export and the rest of the standard set are the **Essentials**, installed on first launch. Anything else, such as virtual copies, collections or lens profiles, comes from the in-app store (**Ctrl+Shift+X**). See [Using Extensions](using-extensions.md) for what that means for your edits.

## Names you know

| Lightroom / Capture One | Safelight | Where |
|---|---|---|
| Catalogue, session | Project (a folder) | **Open Folder** in the Folders panel |
| Import | Open the folder where the files are. Safelight works on files where they sit and doesn't copy from a card. | Library |
| Grid, Loupe, Filmstrip | Library grid, Develop, and the **Filmstrip** extension under the Develop canvas | Library, store |
| Stars, flags, colour labels | The same: **1–5**, **P / X / U**, **6–9** | Library |
| Keywords | Keywords panel. Keyword trees, synonyms and Lightroom keyword-list import come with **Hierarchical Keywording**. | Library, store |
| Collections, smart collections | **Collections** extension | Store |
| Virtual copy | **Virtual Copies** extension: right-click a photo | Store |
| History | Undo (**Ctrl+Z**), redo (**Ctrl+Shift+Z**) and reset all edits, also as buttons in the Edit History panel. Every edit is kept with the photo, so undo works after you reopen it. | Develop |
| Snapshots | Not yet. Save a preset, or use a virtual copy, to keep an alternative. | |
| Presets, styles | Presets panel. Lightroom `.xmp` presets import with **XMP Tools** or **3rd-Party Preset Tools** (which also reads `.lrtemplate`). Capture One styles don't import. | Develop, store |
| Copy / paste settings, sync | Right-click in Library: **Copy settings…** picks what to copy, **Paste settings** applies it to the selection. **Batch Tools** adds selective sync and batch Auto. | Library, store |
| Before/after | **Image Comparison Tools**: hold to preview, or a draggable split | Store |
| Masks: brush, linear, radial, range | Masking: brush, linear, radial, luminance range and colour range, combined with add, subtract and intersect. Up to 16 masks and 24 components per photo. | Develop |
| Healing, clone | Heal, with up to 32 spots per photo | Develop |
| Camera profile, Adobe Colour | The **display transform** (tone mapper), picked per photo in Develop's bottom bar. Camera-maker profiles (DCP) aren't supported yet. | Develop |
| Lens profiles | **Lens Correction** extension (Lensfun database and Adobe LCP profiles) | Store |
| Export presets, filename templates | Export panel: named export presets and filename templates | Library |
| Client proofing gallery | **Web Tools** extension | Store |
| XMP sidecars | **XMP Tools** reads sidecars on import, and writes them once you turn writing on in its settings | Store |

## Not available yet

- **AI masks** (Select Subject, Sky, People). Planned. Use brush and range masks for now.
- **Soft proofing.** Coming with the next processing version.
- **Tethered capture.**
- **Lightroom catalogue import.** See below for what you can bring across.
- **Camera-maker colour profiles (DCP).**

## Moving from Lightroom

What comes across, and how:

1. **Ratings, labels, flags and keywords.** In Lightroom, select the photos and choose **Metadata ▸ Save Metadata to File**, which writes `.xmp` sidecars beside your RAW files. Install **XMP Tools** in Safelight, then open the folder. The metadata is read as the photos are added.
2. **Keyword hierarchy.** Export your keyword list from Lightroom (**Metadata ▸ Export Keywords**) and import the `.txt` file into **Hierarchical Keywording**.
3. **Presets.** Import your `.xmp` presets in the Presets panel with XMP Tools installed. Tone and colour sliders, sharpening, noise reduction, HSL, tone curves and colour grading are mapped. Crop, transforms, lens corrections and masks aren't.

What doesn't come across: Lightroom's edits themselves. Lightroom's processing is its own, so a photo you edited there opens in Safelight unedited, and you rebuild the look (a converted preset is a good start). Collections, virtual copies and history also stay in Lightroom.

## Event and sports shooting

If you ingest and cull with Photo Mechanic, keep doing that for now. Safelight doesn't yet:

- copy from cards, make backups or rename files on ingest (it opens the folder the files are already in),
- edit IPTC captions, copyright or metadata templates, or do code replacements,
- send files by FTP, or capture tethered.

Ratings, labels, flags and keywords from Photo Mechanic come across through XMP sidecars with **XMP Tools**. Culling in Safelight is all keyboard (**1–5**, **P / X / U**, **6–9**, arrows), and **Delete from disk…** has no key until you give it one in **Preferences ▸ Shortcuts**.

## Working at volume

- **Previews.** Safelight keeps a decoded copy of each RAW you open in Develop, so it reopens instantly. It's stored in the project's `.safelight` folder and can take a lot of space on big shoots. Change its size or turn it off in **Preferences ▸ Previews**.
- **Speed.** On laptops and other machines whose graphics share memory with the processor, **Preferences ▸ Performance ▸ Integrated graphics** sets lighter settings in one click.
- **Culling in Develop.** The **Filmstrip** extension adds thumbnails under the canvas with the same rating, flag and label keys as the grid. **Duplicate Photo Detector** finds bursts and near-duplicates.
