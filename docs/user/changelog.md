# Changelog

All notable changes to Safelight are documented in this file.

## [Unreleased]

### Added
- **Extension releases and versions** — extensions that publish GitHub Releases now install and update from their newest release, so work in progress on an extension's main branch no longer reaches you; extensions without releases update from their branch as before. An extension's store page lists its versions: install an older one to go back to it, and Safelight keeps you there until you choose Latest or update. Pre-releases install only when you pick one. Release notes show on the store page under **What's new** and in the Updates tab. Update checks now read versions from the Safelight extension registry instead of asking GitHub about every extension, so they no longer run into GitHub's hourly limit. For authors: a release can carry a zip of the built extension instead of committing `dist/`, and the developer docs include a workflow that builds, checks and publishes a release when you push a tag.
- **Welcome setup** — on a fresh install Safelight opens a short setup: pick a theme, interface font and scale, and accessibility switches; set up the workspace (canvas surround, slider behaviour, single-key shortcuts, restoring the last project); then pick **starter kits** of verified extensions by shooting style (film looks, colour work, detail and repair, organising, events and volume, coming from Lightroom, make it yours). Open a kit to pick single extensions; an extension in two kits installs once. Kits come from the extension registry, so they change without an app update. Setup shows the same third-party notice as the Extensions store, installs only reviewed versions (anything banned, unverified, newer than its review, or whose review can't be confirmed right now is skipped with the reason), and stays open until every install has finished or failed, with Retry on failures and a note when an extension needs a restart for network access. People upgrading are not interrupted. Run it again from the welcome screen's **Welcome setup**, **Preferences ▸ Interface ▸ Welcome setup**, or **Starter kits** in the Extensions store.
- **Processing stages can declare the values they see** — `space` (`{ encoding: "linear" | "perceptual", primaries?: "rec709" | "rec2020" }`) makes the core convert a stage's `lin` or `c` in before its GLSL and back out after it, so display-referred math can run on values past [0, 1] and a stage can work in Rec.2020 without touching the core's working values. `reads: "current"` makes a stage's passes start from the image as edited up to the stage instead of the decoded source, drawn into a float texture ahead of the passes. New edits carry `DevelopParams.processVersion: 2`, which keeps full-range values after the display transform until a tool that needs [0, 1] is in use (core Vignette and Grain never clip, so a stage after them that declares `space` still gets values outside [0, 1]); edits saved before it render as version 1, exactly as before. Registration refuses an invalid `space` or `reads` and warns about parts of the contract the core ignores. Set `minAppVersion` when a stage relies on these fields: older builds ignore them and hand the stage legacy values.
- **Stage ordering, and the reserved parts of the stage contract.** `after` now orders a stage inside its phase: it runs after every registered stage it names in that phase, even against `priority`, and stages that name each other in a cycle lose the entries between them, with one warning per cycle. `produces`, `consumes` and `mask` are reserved and not implemented, so registering a stage that sets one now warns, and so does a `phase` the core doesn't list (the stage sorts after every listed phase). Ids under `core.` and `builtin.denoise` belong to Safelight's own stages, and an extension that registers one is refused.
- **A stage that can't be built is remembered.** A stage whose GLSL fails to build used to be compiled and fail again on every frame. The failure is now remembered until the stage set changes, so its frames fail without another compile, and the renderer recovers as soon as the stage set changes.
- **Update processing for older edits.** Photos you edited in an earlier version keep their look. A new **Update processing** button in Develop's status bar, and an item in the Library right-click menu for a whole selection, moves them to the new processing, which keeps bright, very saturated colours. Every other setting stays, and Undo puts a photo back.
- **Extension modules** — an extension can now register a top-level module beside Library and Develop (`api.registerModule`): it gets its own tab, pop-out window and dock layout, and `navigation.goTo` accepts its id. The Extensions store gained a **Modules** category. This is what the new **Map** extension uses. Photo surfaces gained two helpers: `api.catalog.useVisiblePhotos({ without })` leaves out named grid filters, and `api.catalog.requestThumbnail(id)` loads a preview for surfaces that draw thumbnails themselves.
- **Painted coverage for extension stages** — a GPU processing stage can declare a `coverage` texture and read the brush dabs an extension paints into the photo's edit as `float key(vec2 uv)`. The coverage is baked per render, so a painted mask persists, undoes, and matches in Develop, thumbnails and export. This is what the new **Moiré Reduction** extension uses to confine its effect to a painted area.
- **Delete from disk** — the Library grid's context menu can move selected photos' files to the OS Recycle Bin / Trash (recoverable — never a hard delete) and remove the photos from the catalog. A photo stays in the catalog if its file couldn't be trashed (e.g. a write-protected card), with the reason reported. Virtual copies are skipped, since a copy shares its master's file. The action is also available as a rebindable shortcut that ships unbound.
- **Thumbnail size from the keyboard** — **- / =** shrink and grow the Library grid thumbnails one slider stop per press (rebindable, numpad **+** works too).
- **More app shortcuts** — **Ctrl+O** opens a folder, **F2** renames the active photo, and **Ctrl+R** shows it in the OS file manager. All rebindable in Preferences ▸ Shortcuts.
- **Display transforms can bring their own highlight roll-off** — a display transform extension can set `skipToneShoulder` to bypass the core filmic shoulder, which compresses luminance above 0.85 at Highlights 0, so it receives exposure-scaled scene-linear values with their headroom and shapes the brightest tones itself. This applies to photos on the current processing; photos edited before keep the core shoulder and their look. Highlights keeps working under such a transform, globally and in masks: pulling it down blends in the core recovery in proportion to the slider, and pushing it up lifts tones up to white while leaving anything brighter than white untouched. The extension docs were corrected alongside: `skipBaseCurve` drops the baseline tone only (the core shoulder still runs unless `skipToneShoulder` is set), the `decode` stage phase runs on the linear colour after the baseline tone at the same point as `noise-reduction`, and scene-linear colour can carry negative channels that stages must guard before a `log`, `pow` or `sqrt`.
- **Restyleable input controls** — extensions can now register a stylesheet (`api.registerStylesheet`) that applies in every window after the core styles, and the input controls expose stable styling hooks: the Develop slider gained a knob element (hidden by default) and `sl-slider-*` classes, the toggle switch is one shared component with `sl-switch-*` classes, and the dropdown and segmented control carry `sl-select` / `sl-segmented`. This is what the new **Input Styling** extension uses for its presets (round, square, pointed or line slider knobs; square, rounded or pill corners; drawn checkboxes; numeric fields that grow while you type) and for user-written custom CSS.
- **Layouts remember your panel and tool extensions.** Saving a layout, or updating one with ↻, also records which panel and tool extensions are on, and picking the layout switches them to match, so a lean culling layout can turn off the panels it doesn't need. Extensions that change how photos look or export (processing stages such as film simulations, display transforms, export add-ons), Accessibility and Developer Tools are never switched by a layout. Layouts saved before this update leave your extensions alone until you update them.

### Changed
- **Highlights and Shadows keep texture** — on photos using the current processing (photos you start editing now, or after **Update processing**), Highlights and Shadows work on regions of the photo instead of on each pixel alone. Pulling Highlights down darkens bright areas as a whole and keeps the clouds and detail inside them instead of turning them grey, and points brighter than their surroundings can still reach white at -100. Lifting Shadows opens dark areas without turning them into haze. Moving Highlights or Shadows no longer adds fine-detail contrast on its own. Photos edited before keep their look.
- **Bright colours ease into white** — on photos using the current processing, raising Exposure (or anything else that brightens a saturated colour) draws the colour toward white once its strongest channel nears white, keeping its hue, instead of letting that channel clip on its own into a flat, shifted colour. Colours that stay clear of white don't change. Display transforms with their own highlight roll-off, such as Advanced Rendering's, shape bright colours themselves. Photos edited before keep their look.
- **Interface scale has − and + buttons** — in Preferences ▸ Interface, Preferences ▸ Accessibility and the welcome setup, the scale now steps 10% at a time between 80% and 200% instead of using a slider, so the window no longer rescales under the pointer while you drag. A scale set between steps earlier moves to the next step when you press a button.
- **A new look** — Safelight has a new logo: the "safelight." wordmark and an "s." app icon, sharp from the 16 px taskbar icon up. The interface now uses Afacad, a geometric typeface that ships with the app, with fixed-width numbers so slider values hold still while you drag. **Preferences ▸ Interface ▸ Interface font ▸ JetBrains Mono** brings back the previous look, and a font you picked before keeps applying. The Windows installer matches the new look. Extensions that style text with `var(--font-mono)` follow the interface font; code views use the new `--font-code`.
- **More colour information is kept while you edit.** Photos you haven't edited yet, and the edits you start on them, now keep bright, very saturated colours instead of clipping them early. Some tools, such as Contrast and Saturation, still clip them while you use them, and exports still fit them to sRGB at the end. You may see slightly different edges on those colours. Photos you edited before look exactly as they did, until you use Update processing or Reset all edits on them.
- **Tone curve end points move sideways** — the curve's black and white points were locked to the left and right edges and could only move up and down. They now move freely: slide the black point right along the bottom to clip shadows to black, or the white point left along the top to clip highlights, and lift or lower them in the same drag. The curve stays flat beyond a moved end point. With keyboard canvas editing on, the left/right arrows and the **In** field work on end points too. End points still can't be removed.
- **Display transform per photo** — the display transform menu in Develop's bottom bar now picks the tone mapper for the photo you're editing instead of switching every photo. The pick is saved with the edit: it undoes, travels with presets, Copy/Paste Settings and sidecars, and applies to that photo's thumbnail and export. **Preferences ▸ Rendering ▸ Default display transform** covers photos without their own pick, and existing edits follow it, so nothing changes on upgrade. Extensions can ask which transform a photo renders with through `api.pipelines.effectiveId`; `api.pipelines.apply` and `usePipelineStore`'s `activeId` now mean the Preferences default, not every photo's transform.
- **The Library remembers your view** — the sort order chosen in the toolbar (imported, captured, name, rating, direction — including extension-contributed sorts) and the thumbnail size now persist across restarts. Preferences ▸ Library ▸ Default sort now applies immediately; the Preferences defaults seed fresh profiles.
- **Faster imports and folder opens** — importing now runs its pixel work (decode, orient, thumbnail) in a pool of background workers sized to your CPU, so big imports use all cores and the app stays responsive. Embedded camera previews (and plain JPEGs) decode straight to thumbnail size instead of at full resolution, and are decoded once instead of twice per RAW; the embedded-JPEG search hops between markers natively instead of walking every byte; sibling folders are listed concurrently; the per-file sidecar probe only runs for sidecars that exist; catalog progress saves re-serialize less often during a long import; and cached grid previews load three at a time when reopening a catalog.
- **Dragging is lighter on photos with painted work.** Settings that didn't change, such as brush strokes painted by an extension or Safelight's own masks and spot removal, are no longer sent again at every step of a drag. Moving a slider sends only the setting it changes, so dragging stays quick on a photo with large painted masks. Editing a mask redraws the photo once per change, and the histogram is measured once per change instead of twice.
- **Safer extension updates** — an update is downloaded and validated before the running version is touched, and one that fails to start is rolled back to the previous version (and remembered, so auto-update doesn't retry it). Updates that need a newer Safelight are listed with the version they need instead of an Update button, auto-update leaves disabled extensions alone, and an extension whose bundle fails to start on first install is removed again instead of lingering half-installed.
- **Replace extension param values, don't edit them in place.** The photo's param bag now reaches the render worker as patches: only the values whose identity changed are sent. When an array or object value changes, give `setDynParam` or `setDynParams` a new one (a painted `BrushDab[]` included) and never push into or edit the one you set before: a value edited in place no longer reaches the renderer. The same now holds for the develop store's `params`: give `setParam` a new array or object, such as a new `masks` array, whenever one changes.
- **Extension ids `core` and `core.*` are reserved.** They belong to Safelight's own extensions, in any letter case. Installing an extension with one of these ids is refused, and one already installed under such an id no longer loads. The Developer Tools dev folder shows the reason instead of loading it. Ids such as `corel` and `my.core` are still fine.
- **Faster photo opens in Develop.** The photo's stored preview now appears the moment you open it, before the editor has finished starting. A RAW you have opened before opens from its cached preview without reading the original file again, even when the original is offline. A RAW that isn't cached starts decoding while the camera preview is still being prepared, so the full-quality image arrives sooner.
- **The photo you open comes first.** Background decoding (Cache all, next-photo prefetch, thumbnail refreshes) now waits behind the photo you are opening instead of ahead of it. Next-photo prefetch also follows the grid's extension filters and sorts, so it prepares the photo you will actually move to.
- **Turning an extension off frees its graphics memory straight away.** Its look-up textures, compiled shaders and working buffers are released when you switch it off instead of when Safelight restarts. Its code stays loaded until the next restart; extensions that are off at launch are not loaded at all. Extension authors: an extension's stage textures are dropped when it is switched off, so upload them from `activate()`, not only from the module's top level.
- **Update processing and Paste settings are much faster on large selections.** Safelight now saves the whole selection at once instead of one photo at a time.
- **Smoother photo changes in Develop.** The stored preview now eases into the edited image, and the camera's preview into the full-quality one, instead of switching at once. Moving to another photo keeps the one before on screen, in place and at its own shape, until the next photo's first image appears, for at most a moment. Browsing with the arrow keys no longer flashes the background between photos, and in colour assessment mode the white frame stays put. Photos you move through quickly switch at once, and Reduce motion turns the easing off. A photo of a new shape no longer shows stretched for an instant.
- **Develop's corner says what you're looking at.** When a photo takes a moment to open, the corner of the image says Preview, then Full quality for a moment once the full image arrives. When Develop can only show a preview, the corner says why: "Preview (Safelight can't open this RAW yet)", "Preview (this RAW took too long to open)" or "Preview (the original isn't available)". The messages shown when Develop can't draw images at all are plainer, such as "Can't show images right now. Trying again…".

### Fixed
- **Raising Highlights no longer darkens the brightest tones** — above about +13, the curve that eases the brightest tones into white bent back down, so the brightest parts of a photo came out darker than the tones just below them; display transforms such as Advanced Rendering's AgX showed it most. On photos using the current processing the curve now keeps rising. Photos edited before keep their look.
- **Extension stages pick up changes to their helpers and settings** — the renderer only noticed a change to a stage through its `glsl`, its passes' `glsl` and its texture declarations. A stage that changed just its `helpers` (per-stock constants, for one), a pass's `helpers` or `iterations`, or a uniform's default or range kept the program and bindings it first compiled. It now notices a change to any part of a stage that affects rendering.
- **Reopened RAW photos keep their highlight detail** — the cache that lets a RAW open instantly the second time stored its pixels cut off at pure white, so on every later open **Highlights** and **Exposure** had less to pull back than on the first open or in a full-size export, and the repair that restores colour to clipped highlights skipped the photo. The cache now keeps the full range of the RAW decode: a reopened photo recovers the same highlight detail as on first open and in full-size exports, and clipped-highlight colour repair applies to it too. The cache has to be rebuilt once: the first time you open a project after updating, Safelight decodes all of its RAWs again in the background, which keeps the computer busy for a while on a large catalog. With **Preferences ▸ Previews ▸ Cache decoded RAW previews** set to **As needed**, each RAW is decoded again the first time you open it instead.
- **Very saturated colours reach your edits intact** — the RAW decoder clipped colours more saturated than the standard sRGB range can hold (vivid flowers, neon and LED light, deep cyans) before any edit ran. The decoder, and the colour noise reduction that is on by default, now pass them on intact, so your edits and display transforms work from the colours the camera recorded instead of a clipped copy. The built-in display transform and exports still fit them to sRGB at the end.
- **Healing or cloning a spot no longer flattens the whole photo.** On new edits, a single heal or clone spot cut the brightest highlights and the most vivid colours from the whole photo, not just the spot. They now stay as they were. Photos you edited before keep their look until you use Update processing.
- **Colour-fringe and moiré fixes keep working with noise reduction on.** On new edits, Lens Correction's colour-fringe fix and Moiré Reduction were undone by noise reduction, including the colour noise reduction that is on by default. They now keep their effect. Photos you edited before keep their look until you use Update processing.
- **Clarity, Sharpness and Texture in a mask work from the photo's own detail.** On new edits, a mask's Clarity and Sharpness brightened plain, even areas, and its Texture was held back almost everywhere. They now respond only to real detail, the way the sliders for the whole photo do. Photos you edited before keep their look until you use Update processing.
- **Pasted settings stay on the open photo.** Pasting settings from the Library onto the photo that is open in Develop in the main window was undone by the next change you made in Develop. The pasted look now shows at once and stays.
- **Windows no longer undo each other's changes.** With a second window open, saving in one window could undo the ratings, labels, keywords, edits and removed photos you had changed in the other, including edits made in a Develop pop-out. The windows now share these changes for the photos they both show, and Develop picks up an edit made to its photo in another window. Photos added in one window show up in the other after you reopen the project there.
- **A catalog that couldn't be read is no longer replaced.** If a sync or antivirus program was using a project's catalog as the project opened, or the catalog was damaged, Safelight opened the folder as a new project and soon saved over the real catalog, losing ratings and edits. Opening now waits a few seconds for a busy catalog, then stops with a message and changes nothing. A damaged catalog is kept next to the new one, and Safelight restores the project from a backup it now keeps the first time you change a project after opening it. A missing catalog is restored from that backup too. A catalog saved by a newer version of Safelight no longer opens and loses what that version added, and one damaged entry in a catalog no longer stops the project from opening.
- **A catalog save that fails is tried again and shown.** When a project's catalog couldn't be saved (a sync or antivirus program was using it, or the disk was full), Safelight only noted it in a log and didn't try again until your next change. It now tries again by itself and shows "Couldn't save the catalog" with the reason, in pop-out windows too, until a save works. A window that leaves a project and still can't save a change hands it to the other open windows that have it. If it gives up, a notice now says the last changes to that project couldn't be saved.
- **Preset import no longer fails silently** — picking a file the Presets panel can't read used to do nothing at all, so a Lightroom `.xmp` preset imported with no importer extension installed looked like a broken import. The panel now says why: no installed extension reads that file type (with a link to the Extensions store's **Presets** category), the importer found no develop settings in the file, or a `.json` file isn't a Safelight preset this version can read. The Import picker also lists `.xmp` and `.lrtemplate` files before an importer is installed, and an importer that finds nothing no longer saves an empty preset. The docs no longer claim XMP Tools and the other example extensions come pre-installed; they install from the store.
- **Black thumbnails from Leica M8 DNGs** (and any DNG that stores its sensor data through a linearization table) — these files carry 8-bit codes that a table in the file expands to the sensor's real 14-bit values, and they embed no JPEG preview to fall back on. The import decoder scaled the raw codes against the 14-bit white level, so every pixel landed within 2% of black and the grid showed a black tile while Develop, which decodes through LibRaw, showed the photo. The table is now applied before the black and white levels, as the DNG specification requires. **Rebuild thumbnails** refreshes previews built before the fix.
- **Network access for dev-folder extensions** — an extension loaded from the Developer Tools dev folder now gets the network origins it declares in `permissions.network` the same way an installed one does: read at launch and allowed by the app's content-security policy after one restart, which the Dev tab and Preferences ▸ Developer Tools now ask for. Previously only installed extensions widened the policy, so a dev-folder extension's requests to its declared hosts were refused.
- A failed extension update (network error, or a release that needs a newer Safelight) no longer leaves the installed version disabled until restart, and updating a disabled extension no longer switches it back on. Extension files are now replaced atomically, so an interrupted install can't leave a half-written copy.
- **Fujifilm RAF metadata** — RAF files now import with their EXIF (orientation, capture date, camera, lens, exposure) and XMP. A RAF keeps them inside the JPEG preview its header points to, which the metadata reader didn't follow, so every Fuji file arrived without them and its thumbnail could not be brought upright. Exports from RAF files now carry the EXIF too. RAF photos imported before this fix pick their metadata up on **Re-import**.
- **Squashed or sideways thumbnails from JPEGs that carry an orientation tag** — the browser engine applies a JPEG's own EXIF Orientation on decode even when asked not to. An embedded preview with such a tag (Fujifilm's has one) came out upright and was then squashed into its sensor-native resize box and turned again, and a portrait JPEG imported through the fast path was turned twice. The tag is now left out of the bytes handed to the decoder, so every decode starts sensor-native and the file's own EXIF alone decides orientation, in the grid and in Develop. **Rebuild thumbnails** refreshes previews built before the fix.
- **Opening an edited photo no longer flashes an over-processed frame.** Develop showed an edited photo's stored preview, which already includes your edit, with the edit applied a second time, so the first moments looked over-processed and the live histogram showed white, clipped bars before settling into its real colours. The stored preview now shows as it is until the full photo arrives, the histogram starts fresh for each photo instead of morphing from the previous one, and a photo is never drawn with the previous photo's settings while its own edit loads.
- **Switching an extension on and off quickly could leave it running.** Switching an extension off while it was still starting could leave it active although shown as off, and turning it on twice in quick succession could start it twice. Changes now apply one at a time, in the order you make them.
- **Changes made while a folder opens are kept.** Ratings, flags, labels, keywords, rotations, removed photos and virtual copies made while Safelight was still scanning a folder were undone when the scan finished. On a folder's first open they were saved into the project open before it, or not at all. They now stay with the folder you're opening, and closing a project or opening another no longer saves anything into the one you left.
- **Opening or closing a window no longer rewrites the catalog for nothing.** Opening, popping out or closing a window no longer rewrites the catalog when nothing changed, and a window that leaves a project mid-import no longer undoes ratings or edits made in another window.
- **Changes made in two windows at once are no longer lost.** A rating, flag or edit made in one window just before a pop-out opened, or while its save was failing, could vanish once the pop-out saved. A change one window made while another was still opening the folder could be undone, and two windows changing different things on one photo could each lose the other's change. Every window now keeps the newest change to each part of a photo, and a window that opens asks the others for changes not saved yet. A photo removed in one window just before another opens no longer comes back.
- **Rating a photo no longer reloads its thumbnail, and turned photos turn in other windows.** Rating, flagging or labelling a photo no longer reloads its grid preview. A photo you rotate now turns in your other open windows too, without reopening the project there, and those windows reload turned previews a few at a time, so turning many photos no longer slows them down.
- **Turned photos never show the wrong way round.** If Safelight quit before a turned preview was stored, or storing it failed, the grid showed the old preview the wrong way round for good. It now builds the preview from the photo instead.
- **A full or locked disk no longer hides ratings and labels.** When a preview couldn't be stored, the rating, flag, label, keyword, move or copy name you had just made didn't show until you reopened the project. It now shows at once and is saved.
- **Opening a photo no longer shows an old look as if it were the edit.** Develop now draws a photo's stored preview first only when it shows the photo's current edit. After Paste Settings, Update processing, an extension's edit, rebuilt previews, or turning **Store previews on disk** off and on again, an older or unedited look no longer flashes first; the current look appears when the photo loads. Photos edited before this update open without their stored preview until their next edit. An edit an extension made to the photo open in Develop, such as a batch Auto in Library, is no longer lost on your next edit there.
- **The histogram and Auto look at the whole photo when you zoom in.** While zoomed in, the histogram, Auto Tone and Auto White Balance measured only the part of the photo on screen. They now measure the whole photo, as at Fit.
- **Develop no longer replays your slider moves after you let go.** On a heavy photo, or with a slower graphics chip, the image kept changing for seconds after you let go of a slider, playing back the moves it had fallen behind on. It now settles on your last change straight away.
- **Aspect-locked crops match rotated photos.** Going back to a photo Develop still held could draw an aspect-locked crop stretched on a rotated photo. The crop now always matches the picture on screen.
- **Develop says when it can't show a photo.** When Develop couldn't take a photo for editing, the corner said Preview and the sliders did nothing. It now says "Can't show this photo." Opening the photo again tries again.
- **Moving quickly through RAW photos no longer holds up the one you stop on.** In Develop, the photo you stop on no longer waits for the ones you skipped, or behind background caching, which now always leaves a decoder free for the photo you open. Opening a photo draws it once instead of twice.
- **Switching projects stops the work for the one you left.** Switching or closing a project now stops its preview repair and RAW caching at once, and also **Cache all now**, **Rebuild thumbnails** and **Re-import** started for it, so they no longer slow down the next project or touch its cache, and a photo in the next project never shows the previous project's cached pixels. Preferences says "Stopped." for a pass stopped this way. Pop-out windows leave this work to the main window, and a photo you open goes ahead of preview repair and rebuilding.
- **Cache all no longer stores a bad RAW decode.** A decode with the wrong colours or guessed dimensions was cached, then shown every time you opened the photo. It is no longer stored.
- **RAW files Safelight can't decode no longer slow every open.** A RAW the decoder can't use, such as a compressed file from a camera newer than its RAW engine, was decoded again, and failed, on every project open, every Cache all and every visit to Develop. Once two separate launches have failed on a file, Develop opens it on the camera's preview at once, and background caching and preview repair leave it alone. **Re-import**, or **Clear preview cache** in Preferences, tries the file again. The grid's warning on a photo without a preview now gives that photo's own reason in plain words, and a cache file left half-written by a quit no longer counts as cached.
- **A RAW that stalls the RAW engine no longer stalls Safelight.** A RAW file that made the RAW engine fail or stop responding left Develop loading forever and could stall Cache all, and after a few such files nothing could be decoded until a restart. After a generous time limit the photo now shows the camera's preview, and the next photos decode normally. Background caching tries such a file only once per launch, and two nearby photos no longer both wait on it. Opening it in Develop still tries again.
- **A photo showing a preview loads properly when it can.** A RAW that showed only the camera's preview, because its decode took too long or was busy elsewhere, kept showing that preview for the rest of the session, and a photo opened while its original was offline kept its stored preview after you reconnected the originals. Opening the photo again now decodes it, or loads the original. Such a photo could also switch to the next photo's picture a moment after opening, and the sliders then edited that picture. It no longer does.
- **Edited photos no longer get their edit applied twice while the original is away.** When a photo's original couldn't be read, Develop, the grid, batch Auto and export could take its stored, already edited preview and edit it again, and the grid saved that result over the preview. Develop now shows the stored preview as it is while it matches the edit, and says "The original isn't available." once it doesn't. The grid keeps the preview as it is, and export skips the photo with "The original isn't available." The Export panel now lists each photo it couldn't export, with the reason.

### Planned
- B&W and HDR image support
- HDR / focus stacking and photo merge
- AI masking via ONNX.js (Select Subject, Sky)
- Lightroom catalog import (sql.js)
- Mobile-responsive viewing
- Camera profile / base tuning controls
- Stage-by-stage migration of the develop shader to extension-contributed processing stages

## [2.4.4] - 2026-06-29

### Added
- **Read-only sources (memory cards, immutable systems)** — Safelight can now open folders it can't write to, such as a mounted SD card or a read-only mount on systems like Fedora Silverblue. When the photo folder can't host its `.safelight` catalog, the catalog, previews, and cache are redirected to a writeable location automatically and a non-blocking banner shows where they went; when the folder later becomes writeable, edits made during the read-only session are folded back into the in-folder catalog.
- **Catalog storage preferences** — Preferences ▸ Previews now lets you keep each project's `.safelight` catalog **in the photo folder** (default) or in a **separate folder** (to keep photo folders clean), choose where separate catalogs live, and browse and delete every catalog stored outside its photo folder to reclaim disk space.
- **Sliders jump to cursor** — an optional toggle (Preferences ▸ Interface): click anywhere on a slider track to snap the value to that point and drag from there, instead of grabbing the current value.
- **Display-transform quick switch** — a status-bar control next to Assess in Develop switches the active display transform when an extension provides one (for example a film-simulation or denoise look) without opening Preferences.
- **Black and white surround endpoints** — the neutral canvas surround adds pure black and white beyond the five-shade grey ladder; middle grey stays the default and the colour-assessment standard.
- **Extension network permissions** — extensions can declare the network origins they need in their manifest; the store shows them, and requests to undeclared origins are blocked.
- **Full-resolution rendering for extensions** — extensions such as web-gallery publishers and batch / sync-edit tools can render any library photo through the full develop pipeline at export resolution, not just from low-resolution previews.

### Changed
- **Back to pure GPLv3** — the dual-licensing scheme and Contributor License Agreement introduced in 2.4.1 are removed. Safelight is free software under the GNU GPL v3 with the standard inbound = outbound model: you license your contribution under GPL v3 and keep your copyright, with no agreement to sign. Added `THIRD-PARTY-NOTICES.md`, `TRADEMARKS.md`, `PRIVACY.md`, `EXTENSIONS.md`, and a security policy, all linked from Preferences ▸ About.
- **Clearer extension trust states** — install prompts and detail pages now distinguish *verified* (reviewed at a point in time), *stale* (verified, but the installed version is newer than the reviewed one, shown as an amber ✓*), and *unverified*, and spell out that verification is not a guarantee of safety — extensions run with full access to your photos, metadata, and files.

### Fixed
- Read-only source folders (mounted memory cards, immutable Linux systems) no longer fail silently when opened.

## [2.4.3] - 2026-06-29

### Added
- **Rename and re-import in the Library** — rename a photo's file on disk from the grid context menu (the original extension is preserved), and **Re-import** selected photos to rebuild thumbnails and re-read EXIF/file metadata while keeping ratings, labels, keywords, and edits.
- **Show in folder / Open folder** (desktop) — reveal a photo in the OS file manager from the Library, and jump straight to the export destination after a folder export.
- **HSL "All" layout** — show every HSL band stacked at once (in addition to the one-band-at-a-time tabs), with a compact band selector while the on-image target picker is active.
- **Coloured slider tracks** — sliders can draw a hue / lightness gradient behind the track (used by the HSL mixer).

### Changed
- **Lens correction is now an extension** — distortion, chromatic-aberration, defringe, and vignetting correction, along with the bundled Lensfun profile database, move out of the core app into a standalone Lens Correction extension, keeping the base app lean. Install it from its repository if you need it.
- **More mask adjustments** — local-adjustment masks gain whites, blacks, vibrance, texture, and dehaze.
- **Smarter preset saving** — the save dialog separates global adjustments (offered when changed) from per-image edits like crop and retouch (hidden under "Show all," since they don't transfer meaningfully to other photos), and presets can include extension-stage adjustments.
- **Hold-to-preview on more panels** — the per-panel preview-off eye is now momentary (press and hold) and works on Crop & Straighten and Transform, hiding their on-canvas overlays while held.

### Fixed
- **Accurate crop dimming** — the crop overlay dims only the image area, not the canvas surround, so straightened photos no longer show a dark frame in colour-assessment (Assess) mode.
- **Colour picker when zoomed** — eyedroppers sample the correct pixel when the canvas is zoomed or panned into a region.
- **HSL target picker accuracy** — the on-image picker uses the same band weights as the shader, so dragging matches the result.
- Keyboard input on a focused slider no longer creates spurious undo steps when a global shortcut (Ctrl+Z / Ctrl+Y) is released over it.

## [2.4.2] - 2026-06-27

### Fixed
- **macOS "Safelight is damaged" guidance** — the app isn't notarized by Apple, so macOS can block the unsigned download with a misleading "damaged" message. Installation and the FAQ now document the one-time `xattr -cr /Applications/Safelight.app` fix (with a code-signing fallback for macOS Sequoia and later) and explain why an un-notarized build is shipped.

## [2.4.1] - 2026-06-27

### Added
- **Rebuilt noise reduction** — the Detail panel's noise controls expand into separate luminance and colour sliders (amount and detail, plus contrast, shadow / highlight balance, and chroma smoothness) driven by a new multi-pass, edge-aware wavelet denoiser. It only runs when an amount is above zero, so there's no cost when unused, and Alt/Ctrl-drag previews the luminance and colour passes on the canvas.
- **Per-panel preview-off** — each adjustment panel header gains an eye toggle that temporarily renders the photo as if that panel's adjustments weren't there, for a quick before/after of a single panel, without touching your edit history.
- **Clearer Library labels** — grid thumbnails and list rows gain colour-label bars and a faint cell tint, keyword-count badges, and repositioned pick / reject flags for easier at-a-glance culling.
- **Web-gallery publishing support** — the desktop app now lets extensions reach gallery backends (Cloudflare Workers and configurable origins), enabling the Web Tools extension to publish proofing galleries.

### Changed
- **Dual licensing and sponsorware funding** — Safelight gained a commercial license alongside GPL v3 and a Contributor License Agreement for core contributions, under a sponsorware funding model (the app stays free; features are funded through sponsorship). *(Reverted in 2.4.4 — see above.)*
- **Refined Clarity and masked Sharpness** — Clarity uses an edge-aware blur to avoid halos on hard edges, and mask Sharpness blends fine and broad detail to tame overshoot at bright edges.

### Fixed
- A failed processing stage (including the new denoiser) is now disabled for the session instead of stalling the Develop view.
- When a community extension provides its own noise reduction, the built-in denoiser steps aside instead of stacking with it.

## [2.4.0] - 2026-06-25

### Added
- **Accessibility tools** — a new built-in **Accessibility** extension (Preferences ▸ Extensions; disable it if you don't need it) layers opt-in accommodations *on top of* any theme without altering the theme itself:
  - **Match system accessibility settings** — also honour the operating system's reduced-motion, increased-contrast and reduced-transparency preferences (Windows High Contrast mode is always respected). The options below add to these; they never switch a system preference back off.
  - **High contrast** — override the active theme with a maximal-contrast WCAG-AA palette (the Dark and Neutral themes switch to a high-contrast dark palette, the Light theme to a high-contrast light one). Your default theme is untouched while this is off.
  - **Interface scale** up to 200%, **Larger text** (enlarges the smallest labels and drops their all-caps styling), and **Larger controls** (≥24px hit targets).
  - **Lowercase headings** (Title Case instead of UPPERCASE), **Strong focus indicator**, **Reduce transparency**, and **Reduce motion**.
  - **Colour-vision simulation** — preview the whole window through protanopia / deuteranopia / tritanopia filters to check how the interface and your photo read to colour-blind viewers (turn off for colour-critical editing).
  - **Keyboard canvas editing** — drive direct-manipulation tools with the keyboard: focus a tool such as the tone curve or a mask and use the arrow keys, with a numeric point/geometry editor. **Editing highlights** toggles the on-canvas selection/focus ring.
  - **Colour overrides** — fine-tune individual interface colours on top of the active theme.

### Fixed
- **Accurate Develop histogram** — the live histogram is now computed in the render worker from the float (RGBA16F) render pipeline instead of being read back from the 8-bit display canvas, so it no longer shows comb/banding gaps after a tonal stretch (exposure, white balance, or curve adjustment).
- **Black exports from some extensions** — exports now seed the export renderer with the active display pipeline and the live stage-texture set (film LUTs, spectral tables, …), so extension GPU processing stages (e.g. custom film simulations or denoise) bake into the output correctly instead of rendering pure black.

## [2.3.1] - 2026-06-24

### Added
- **Copy/paste develop settings in the Library** — right-click a photo and choose **Copy settings…** to pick adjustments from the same checklist used for presets (including extension stages); **Paste settings** then merges the chosen adjustments onto every selected photo, undoably, without opening Develop.

### Changed
- **Faster Extensions store thumbnails** — browse cards now resolve their image in the main process (manifest icon → custom social preview → owner avatar), batched with per-fetch timeouts and pushed progressively, so a single slow repo no longer stalls the whole grid.

### Fixed
- **Removed photos stay removed** — a photo removed from the catalog is no longer re-imported on the next folder open. Its file is tombstoned (the original on disk is untouched); the tombstone clears automatically once the file leaves the folder.
- **Embedded-preview orientation** — RAW thumbnails from cameras that store the embedded preview already upright no longer double-rotate; orientation is disambiguated against the master RAW's EXIF using the preview's aspect.

## [2.3.0] - 2026-06-23

### Added
- Geometry/warp tool extension APIs — a `geometry`-phase processing stage that warps source coordinates, plus per-photo opaque sidecar storage (`api.develop.putPhotoData` / `getPhotoData`) for large tool payloads such as warp displacement fields.
- Extension trust registry — a GitHub-backed verified/banned list with a sealed privileged bridge so extensions can't reach raw filesystem or the update installer.

### Changed
- More usable Library grid selection.

### Fixed
- Heal tool and develop-canvas render fixes.

## [2.2.0] - 2026-06-21

### Added
- **TIFF export** — 8-bit and 16-bit TIFF output through the same GPU pipeline as editing, with the selected color space's ICC profile embedded. 16-bit uses float render targets and falls back to 8-bit when unavailable.

## [2.1.1] - 2026-06-21

### Fixed
- Assorted bug fixes.

## [2.1.0] - 2026-06-21

### Added
- Expanded the extension API surface and filled in previously missing extension UI.
- Network connectivity handling for the Extensions store, plus documentation updates.

### Fixed
- Extension updater fixes.

## [2.0.1] - 2026-06-20

### Fixed
- Extension store thumbnails failing to display.

## [2.0.0] - 2026-06

The orchestrator release. The core became a **blind orchestrator**: it exposes contribution points and extensions fill them, with every stock panel and tool now a pre-installed extension registered through the same public API external plugins use.

### Architecture
- Rendering moved into a **Web Worker on an `OffscreenCanvas`** (`render-worker` + `RenderBridge`); no render-path code touches the DOM. Added a budget-bounded GPU source cache for instant photo switching.
- Greatly expanded the extension API beyond panels/themes/layouts/slider icons/settings to include: render pipelines (display transforms), GPU processing stages (forward path), keyboard shortcuts, export processors, filename templates, lens profiles, catalog lifecycle hooks, preset importers, grid filters, library sorts, and named UI slots — plus `preferences`, `navigation`, `keybindings`, `pipelines`, and `develop` (overlay + off-screen capture) API objects.
- Installable extensions now live at the repo-root `extensions/` folder, are built with rolldown, and install into `<userData>/plugins/` served under the cross-origin-isolated `app://` origin.
- Extensions store rebuilt as a GitHub-backed app store (master/detail, READMEs, categories, update checks).

### Develop
- **Upright** perspective correction (Auto / Level / Vertical / Full / Guided, with on-canvas guide lines).
- **Mask components** model: each mask combines radial / linear / brush / luminance-range / color-range components with add / subtract / intersect, plus opt-in per-mask sub-panels (white balance, HSL, tone curve, detail).
- **Global** color-grading wheel alongside shadows / midtones / highlights; white-balance and HSL eyedroppers; on-canvas clipping indicators.

### Library & Export
- Keyword tagging and a dedicated Metadata panel; sixth **purple** color label.
- Export gained output color-space conversion with embedded ICC profiles (sRGB / Display P3 / Adobe RGB / ProPhoto), output sharpening, folder delivery, filename templates, and export-processor extensions.

### Bundled extensions
- **Advanced Library Sort** — sort by camera / lens / focal length / ISO, a live search bar, and saved smart searches.
- **Image Comparison** — hold-to-preview and draggable before/after split in Develop.
- **XMP Tools** — XMP sidecar read/write and Lightroom preset import via catalog hooks.

### Platform
- Built-in Lensfun-derived lens-correction database with EXIF matching.
- Linux packaging across deb / rpm / pacman / AppImage / Flatpak; macOS universal `.dmg`; in-app update checker with patch/minor channels.
- Stack: React 19, TypeScript 6, Vite 8, TailwindCSS 4, Zustand 5, dockview 6, Electron 42.

## [1.0.4] - 2026-06-14

### Changed
- Reworked the Masking panel and the mask/heal workflow for clearer per-mask controls
- Faster application startup

### Fixed
- Re-importing a folder no longer duplicates or mis-keys existing photos

## [1.0.3] - 2026-06-13

### Fixed
- Black-image rendering issue on certain RAW files
- Folder support / project scanning fixes

## [1.0.2] - 2026-06-13

### Fixed
- Assorted stability and rendering bug fixes

## [1.0.1] - 2026-06-12

### Added
- `build-scripts/` folder with one-click builds for every distribution target: Windows NSIS installer, Linux `.deb`, `.rpm`, `.pacman` (Arch/Manjaro), Flatpak, and AppImage (built via WSL2 on Windows), and a macOS `.dmg` script (run on a Mac)
- Linux packaging config (`build.linux`) in package.json

### Changed
- Improved Library browsing and Export
- Forward-compatibility groundwork for the extension API
- `build-electron.bat` renamed and moved to `build-scripts/build-electron-windows-exe.bat`; it now prunes `release/` to the single signed installer file
- Code-signing certificate subject changed to `CN=Safelight`

## [1.0.0] - 2026-06-11

First stable release.

### Projects & Library
- Project-based catalogs: open any folder; ratings, flags, and edit histories persist in `.safelight/` inside it (portable, originals untouched)
- Catalog reconciliation against the disk on every open; last project remembered
- Folder tree, grid/list views with adjustable thumbnails, sorting
- Full culling workflow: ratings 1–5, color labels 6–9, pick/reject/unflag, rotate, filters by rating/flag/label
- EXIF metadata Info panel

### RAW
- Full-resolution RAW decoding via libraw-wasm plus an in-house linear-float decoder for uncompressed CFA/DNG
- 19 RAW formats (NEF, CR2, CR3, ARW, DNG, ORF, RAF, PEF, SRW, RW2, IIQ, 3FR, NRW, KDC, MOS, MRW, ERF, SR2, X3F) with embedded-preview fallback
- Decoded-RAW preview cache and background pre-decoding for instant Develop opens

### Develop
- Non-destructive editing with labeled undo/redo history and reset
- White balance, Basic panel (exposure, contrast, highlights, shadows, whites, blacks, texture, clarity, dehaze, vibrance, saturation)
- Point tone curves (RGB + per-channel), 8-band HSL mixer, color grading wheels (shadows/midtones/highlights + luma)
- Detail: capture sharpening (amount, radius, detail, masking), luminance and color noise reduction
- Lens correction (distortion, fringing, defringe, vignetting); effects (post-crop vignette, film grain)
- Crop & straighten with guide overlays, aspect lock, Ctrl+drag leveling, constrain-to-image; transform (perspective, aspect, scale, offset)
- Local adjustments: radial, linear, and brush masks (up to 8) with per-mask tone/color/clarity/sharpness
- Heal and clone retouching (up to 16 spots) with size, feather, opacity, and content-aware source selection
- Presets in an open JSON format (`safelight-preset` v1) with import/export
- 1:1 loupe zoom/pan; Shift fine-adjust and double-click reset on all sliders

### Export
- Batch JPEG/PNG/WebP export through the same GPU pipeline as editing
- Quality and long-edge controls; single-ZIP or per-file delivery
- Camera EXIF, GPS, and XMP stripped from output (wide-gamut exports embed a standard ICC color profile)

### Workspace & Customization
- Dockview-based workspace: dock, tab, minimize, or float every panel; per-module persisted layouts; named layouts via the Layout menu
- Detachable Library/Develop windows with synchronized state for multi-monitor work
- Dark and light themes; UI scale and font preferences
- Fully rebindable, module-scoped keyboard shortcuts
- Preferences dialog (Ctrl+,): interface, library, performance, export defaults, shortcuts, extensions

### Extensions
- Everything-is-an-extension architecture: every stock panel is a pre-installed extension that can be disabled and replaced
- Install extensions live from GitHub (`owner/repo`, branch refs, or URL; official topic `safelight-extension`)
- Extension API v1 (`window.safelight`): panels, themes, layouts, slider icons, declarative settings dialogs, persisted per-extension settings, access to the app's React instance, stock components, and state stores

### Desktop App
- Windows desktop app (Electron + NSIS installer) serving the renderer over a cross-origin-isolated `app://` scheme so libraw-wasm runs at full speed on SharedArrayBuffer workers
- Forced high-performance GPU path (D3D11 ANGLE, discrete GPU, no software fallback); background throttling disabled for uninterrupted decodes
- `build-electron.bat` one-step signed installer build

### Technical
- WebGL2 render pipeline with optional 16-bit float textures for high-bit-depth editing
- React 19, TypeScript, Vite 8, TailwindCSS 4, Zustand 5, dockview
- Multi-window sync via BroadcastChannel + storage events
- Fully offline, zero telemetry
