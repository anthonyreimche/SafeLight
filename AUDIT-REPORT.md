# Safelight deep-clean audit

236 findings after dedup, across 99 files. Status column filled in as fixes land.


## Tier B — Behavioral bugs, non-pixel (auto-fixable, careful) (133)

### `electron/main.cjs`

- **L284 [BUG]** Path-containment checks in the app:// protocol handler use startsWith without a trailing separator (also line 268 for DIST), so a normalized path landing on a prefix-sharing sibling directory (e.g. userData/plugins2 vs userData/plugins) passes containment — same weak-prefix class as the installPlugin issue.
  - _Fix:_ Compare against the base + path.sep (or use path.relative and reject ".."/absolute results) in both resolveRequestPath and the /__plugins__/ branch.
- **L565 [BUG]** installPlugin's tar-entry traversal filter only splits on forward slashes, so on Windows an entry named with backslashes (e.g. "..\\otherext\\main.js", legal in a Linux-authored git repo) bypasses the ".." check, and the weak dest.startsWith(target) guard (no trailing path.sep) then allows writes into any sibling extension directory whose name shares the target id as a prefix — cross-extension tampering inside userData/plugins.
  - _Fix:_ Reject entries whose name contains a backslash or any ".." segment after path.normalize, and replace the prefix check with `const rel = path.relative(target, dest); if (rel.startsWith("..") || path.isAbsolute(rel)) continue;` (or compare against target + path.sep).
- **L578 [BUG]** The install directory is keyed solely by the attacker-controlled manifest.id, and install begins with rmSync of that directory, so any repo can declare the id of an already-installed (even verified) extension and silently replace its code at the authoritative main-process layer — the banned-list check is the only gate.
  - _Fix:_ Record the source "owner/repo" alongside each installed extension (e.g. in a sidecar or the manifest copy) and refuse to overwrite an existing id when the incoming spec's repo differs, unless explicitly confirmed.
- **L622 [BUG]** search-cache.json persists every (topic, query) key ever searched with up to 100 result items each and is never pruned — expired entries (SEARCH_TTL_MS = 15 min) are still written back to disk and reloaded forever, so the file grows without bound across sessions.
  - _Fix:_ Drop entries older than SEARCH_TTL_MS (or keep only the most recent N keys) before serializing in persistSearchDisk, and skip expired entries in loadSearchDisk.
- **L829 [BUG]** searchExtensions falls back to live GitHub search only when fetchRegistryIndex returns null, but an empty items array (registry.json published empty or with all-malformed rows dropped by normalizeRegistryEntry) is truthy, gets cached for the 1h TTL, and blanks the entire store with no live-search fallback — a silent-degrade fallback chain of the exact hidden-ceiling shape.
  - _Fix:_ Treat an empty index as unavailable: `if (index && index.length) return filterRegistry(index, query);` (and avoid caching an empty items array in fetchRegistryIndex).
- **L838 [BUG]** fetchReleases and installRelease interpolate the renderer-supplied repo string into GitHub URLs without the validRepo() check that repoMeta/readme/latest-version all apply, so a repo like "a/b/../../repos/x/y" retargets the API path — and releases:fetch is reachable by any extension via the unsealed bridge.
  - _Fix:_ Add `if (!validRepo(repo)) throw new Error("Bad repository")` at the top of fetchReleases and installRelease, matching fetchRepoMeta/fetchReadme/fetchManifestVersion.
- **L1667 [BUG]** setWindowOpenHandler is installed only on the main window's webContents; detached module windows (children created via that handler) have no window-open handler, so window.open/target=_blank from a child opens arbitrary http(s) URLs in a new in-app Electron window (inheriting the preload/bridge in sandboxed mode) instead of the system browser — will-navigate only covers in-page navigation, not new-window initial loads.
  - _Fix:_ Register the same setWindowOpenHandler (app:// allow with locked-down overrides, https → shell.openExternal, else deny) inside the existing app.on("web-contents-created") hook so every webContents, including children of children, is covered.

### `electron/preload.cjs`

- **L86 [BUG]** plugins.install/uninstall are on the unsealed safelightNative surface (not behind claimPrivileged), so any running extension can silently install another repo whose manifest's permissions.network widens connect-src CSP on next launch (extensionConnectHosts reads ALL installed manifests, enabled or not), defeating the documented "declared and therefore user-visible origins" consent model.
  - _Fix:_ Move plugins.install/uninstall into the one-shot `privileged` object handed out via claimPrivileged (core's store UI already boots first), or have the main-process handler require a native confirmation dialog before writing to pluginsDir.

### `src/catalog/load-image.ts`

- **L37 [BUG]** bitmapToFloat creates a fresh WebGL2 context per call and never releases it (no WEBGL_lose_context, no module-level reuse); it runs once per RAW slow decode via rawColorMatchesPreview, so a batch cache prefetch over many RAWs can exhaust the browser's live-context limit (~16) and force eviction of the oldest context, potentially killing a live canvas.
  - _Fix:_ Call gl.getExtension("WEBGL_lose_context")?.loseContext() after readPixels, or hoist a single lazily-created module-level context (resizing via viewport/texture) and reuse it across calls.
- **L186 [BUG]** Raising the rawCacheMaxEdge preference never invalidates or upgrades existing cached RAW previews for Develop: the fast path returns any cached entry (minEdge defaults to 0), so the documented 'upgrade' branch (lines 243-246) is unreachable unless an export demands more pixels, and the Preferences hint 'Live edits always render full resolution' contradicts Develop actually rendering from the capped cache.
  - _Fix:_ Store the rawCacheMaxEdge (or the native long edge) in effect at write time in the cache entry metadata; on the fast path fall through to the slow decode when the entry was written under a smaller cap than the current setting (entry.cap < getSettings().rawCacheMaxEdge && entry.edge === entry.cap). Also fix the Preferences hint to describe the real behavior.

### `src/catalog/types.ts`

- **L639 [BUG]** normalizeGuidedLines silently drops all guided-upright lines beyond the first 4 on load, but GuidedOverlay lets the user draw unlimited lines and computeGuidedCorrection (rendering/upright.ts) iterates all of them — so an edit made with 5+ lines silently loses lines after reload and recomputing the correction then yields a different result.
  - _Fix:_ Either remove/raise the cap in normalizeGuidedLines (there is no shader constraint on line count), or define a shared MAX_GUIDED_LINES constant and enforce it in GuidedOverlay at add time so the session view matches what survives persistence.
- **L706 [BUG]** normalizeCurve is the only normalizer in the file that performs no numeric validation: it copies persisted point coordinates verbatim, so a corrupt snapshot (NaN, string, out-of-range x/y) flows straight into the tone-curve LUT instead of being sanitized like every other param.
  - _Fix:_ Validate each point (typeof number, isFinite) and clamp x/y to 0..1; if any point fails validation, fall back to DEFAULT_TONE_CURVE for that channel (matching the defensive posture of the sibling normalizers).

### `src/dev/key-diag.ts`

- **L44 [BUG]** The temporary key-diagnostic treats a missing sl_ext_disabled localStorage key as 'Developer Tools enabled', so on a fresh install it monkey-patches window.addEventListener/removeEventListener and logs for normal users on first launch, contradicting its own 'installs ONLY when core.devtools is enabled' gate.
  - _Fix:_ Return false when the key is absent (a fresh profile means default-off devtools): `const raw = localStorage.getItem("sl_ext_disabled"); if (raw === null) return false;`. For the upgrade edge case (old profiles that predate seeding), additionally require sl_ext_default_seeded to include "core.devtools" before trusting its absence from the disabled list.

### `src/extensions/ExtensionDetail.tsx`

- **L114 [BUG]** A repo-relative manifest icon (explicitly allowed by the ExtensionManifest.icon contract) is used raw as an img src, where it both 404s against the app origin and short-circuits the ogImage/avatar fallback chain, leaving a blank icon tile.
  - _Fix:_ Only take manifest.icon when it is absolute (/^https?:/i), otherwise resolve it like the main process does (resolveUrl(icon, "img", repo, branch) from markdown-url.ts, or gh.iconUrl(repo)); on img error, fall through to the next candidate instead of hiding the tile.
- **L129 [BUG]** Built-in extensions' detail pages never show the Enable/Disable or Settings buttons because id is derived from target.manifest?.id and built-ins carry no manifest — even though buildTarget computes hasSettings/enabled for them and their list rows offer both controls.
  - _Fix:_ Add an explicit id field to DetailTarget (builtin.id / manifest.id), populate it in buildTarget, and gate the toggle/settings buttons on that instead of manifest?.id.
- **L314 [BUG]** When the optional github bridge is absent (plain-browser / older Electron where plugins.search still exists), loadRepoMeta/loadReadme no-op so meta and readme stay undefined and the README area shows "Loading…" forever with no error or fallback.
  - _Fix:_ Detect the missing bridge (e.g. !window.safelightNative?.github) and render the "No repository details available" fallback instead of the perpetual loading state.

### `src/extensions/ExtensionManagerPanel.tsx`

- **L321 [BUG]** install() only remembers the install source when fromSearch is present, discarding the repo it already parsed via repoFromSpec(installSpec) at line 252 — so custom imports of "owner/repo" (and detail-page installs whose target.search went stale) permanently lose update checks and installed-detection unless the manifest self-declares repository.
  - _Fix:_ Call rememberSource(manifest.id, repo) whenever repo is non-null (optionally skipping specs that pin a #branch, where release-tracking updates don't apply), instead of gating on fromSearch.
- **L375 [BUG]** Browse's installed-detection builds installedRepos only from remembered sources (readSources) and ignores manifest.repository — the self-declaration escape hatch that repoFor() prefers — so a custom-imported extension that declares its repo still shows in Browse with an Install button (double install).
  - _Fix:_ Build the set from the installed list itself: new Set(list.map((m) => repoFor(m)?.toLowerCase()).filter(Boolean)) — this covers both remembered sources and self-declared manifest.repository (note repoFor returns manifest.repository unnormalized, so lowercase it).
- **L425 [BUG]** The Featured shelf calls the non-reactive isVerified (zustand getState) during render while the component never subscribes to useTrust, so when the trust list arrives asynchronously (first run / cleared localStorage) the shelf silently stays empty until an unrelated re-render.
  - _Fix:_ Subscribe to the verified list in the component (e.g. const verified = useTrust((s) => s.list.verified) and filter against it), so the shelves recompute when the trust registry loads.

### `src/extensions/Markdown.tsx`

- **L36 [BUG]** The inline link regex forbids ']' inside link text, so the most common README construct — a badge image wrapped in a link, [![alt](img)](href) — fails to parse and renders as a stray '[' + image + literal '](href)' text.
  - _Fix:_ Allow one nested image in link text, e.g. /\[((?:!\[[^\]]*\]\([^)\s]+\)|[^\]])+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/y — the recursive parseInline of m[1] already handles rendering the inner image.

### `src/extensions/builtin.tsx`

- **L425 [BUG]** The Effects extension description claims "Vignette, grain and dehaze" but EffectsPanel contains only vignette and grain (dehaze lives in the Basic panel, whose reset list on line 421 includes it), so the Extensions-manager text and the panel's right-click Reset scope contradict actual behavior.
  - _Fix:_ Change the description to "Vignette and grain." (EffectsPanel reads only s.params.vignette and s.params.grain; dehaze is a Basic-panel param).

### `src/extensions/devtools/DevSettings.tsx`

- **L33 [BUG]** The Preferences hint says only "Each immediate subfolder is one extension", omitting (and contradicting) the preferred root-manifest mode where the chosen folder is itself a single extension — a mode scanDevFolder explicitly implements and the Extensions ▸ Dev tab copy documents.
  - _Fix:_ Align the copy with DevExtensionsTab.tsx: "Point at a single extension's folder (a safelight.json manifest plus its built bundle), or at a parent folder whose immediate subfolders are each one."

### `src/extensions/devtools/DevToolsPanel.tsx`

- **L175 [BUG]** Console autoscroll stops following new entries once the log buffer reaches the MAX_ENTRIES cap, because the effect keys on shown.length which stays constant when ingest trims one old entry per new one.
  - _Fix:_ Key the effect on the newest entry identity instead of the count, e.g. [shown.length && shown[shown.length - 1]?.id, autoscroll], or simply on the shown array reference.
- **L496 [BUG]** StorageTab's Save button silently swallows localStorage.setItem failures (quota exceeded), so the click appears to succeed while the value was never written and no feedback is shown.
  - _Fix:_ Surface the failure — e.g. set an inline error state next to the Save button ("Save failed: quota exceeded") in the catch instead of dropping it, mirroring how NativeTab surfaces action failures via `note`.
- **L722 [BUG]** readWebGLInfo creates a fresh WebGL context on every System-tab mount and every Refresh click and never releases it; browsers cap live contexts (~16) and evict the oldest, so repeated refreshes can knock out the app's real render context.
  - _Fix:_ After reading the parameters, release the context: gl.getExtension("WEBGL_lose_context")?.loseContext(); (or cache the result module-level since the values never change per session).

### `src/extensions/devtools/dev-folder.ts`

- **L123 [BUG]** If a dev extension's activate() throws, loadOne propagates the error but leaks the blob URL (never revoked, never stored in blobUrls) and leaves any contributions the partial activate already registered in place (unregisterExtension is never called for it).
  - _Fix:_ Wrap the activate call: try { mod.activate(...) } catch (e) { unregisterExtension(manifest.id); URL.revokeObjectURL(url); throw e; } so a failed activation is swept like unload() does.
- **L136 [BUG]** scanDevFolder has no in-flight guard or generation token, so a folder change (or Clear) arriving via onExtSettingChange while a slow scan is mid-await races it: the stale scan keeps calling loadOne after the new scan's unloadAll, re-activating extensions from the old folder and overwriting items with stale state.
  - _Fix:_ Add a module-level scan generation counter: capture const gen = ++scanGen at entry and bail (return without setState/loadOne) whenever gen !== scanGen after each await; the Rescan button's scanning-disabled state only guards one of the three callers.

### `src/extensions/dock.tsx`

- **L483 [BUG]** bringToFront commits even when the panel is already frontmost, so merely clicking anywhere on a floating panel calls markLayoutCustom() and silently flips an active preset/user layout to "Custom" (plus a spurious localStorage save) with zero actual layout change.
  - _Fix:_ Early-return when the panel is already last in zOrder: `if (s.zOrder[s.zOrder.length - 1] === id) return;` before the commit, so a plain click on the frontmost floating panel is a no-op.
- **L649 [BUG]** Dock drag/drop and resize math stores visual (zoomed) pixel coordinates as layout px, so under the Interface-scale body zoom (uiScale != 1) float-drops land offset from the cursor, rail/float resizes move faster than the pointer, and the drag ghost/drop indicators drift — the exact clientX/getBoundingClientRect desync frameLocalPoint exists to fix.
  - _Fix:_ Divide pointer-derived offsets/deltas by getSettings().uiScale (reuse frameLocalPoint or its /z factor) in startHeaderDrag's float drop, startResize's delta (line 670), and the fixed-position DragOverlay/drop-line coordinates, so stored FloatState and rendered indicators are in layout px like the rest of the app (CropOverlay/MaskOverlay already do this).

### `src/extensions/loader.ts`

- **L82 [BUG]** Re-enabling an external extension bypasses the trust kill-switch: applyEnablement loads the plugin without the bannedReasonForManifest check that loadExternalPlugins performs.
  - _Fix:_ In applyEnablement's external-enable path, run the same guard as loadExternalPlugins: const banned = bannedReasonForManifest(manifest); if (banned) { flagBannedExtension(...); console.warn(...); return; } before loadPlugin(manifest). Otherwise a banned-but-installed extension that happens to be in the disabled list (or is toggled off/on, or enabled from another window via the storage listener) activates despite the ban.
- **L104 [BUG]** initEnablement's storage listener parses the cross-window disabled list without the Array.isArray/string-filter validation that loadDisabled applies, so a malformed value throws inside the listener and can poison useDisabledExtensions with a non-array.
  - _Fix:_ Reuse the same validation as loadDisabled after parsing: if (!Array.isArray(next)) return; next = next.filter((x) => typeof x === "string"); — the two readers of DISABLED_KEY should share one parse helper so they cannot drift.
- **L267 [BUG]** Uninstall (and install/update) is not propagated to other windows: initEnablement only mirrors DISABLED_KEY, so a plugin uninstalled in one window keeps running in a detached window until relaunch, with its contributions live and its settings storage key already deleted.
  - _Fix:_ Broadcast install/uninstall across windows — e.g. write a versioned sl_ext_installed nonce to localStorage on install/uninstall/update and have initEnablement (or a sibling listener) re-list native.plugins and reconcile loaded/registered extensions; ext-settings' storage listener also ignores the removal event (e.newValue == null early-return), leaving stale values in the other window's useExtSettings.

### `src/extensions/pipelines.ts`

- **L55 [BUG]** A registered pipeline with skipBaseCurve: true but no custom glsl is silently collapsed to BUILTIN_RESOLVED (skipBaseCurve: false), discarding a declared flag the PipelineContribution type permits.
  - _Fix:_ Either resolve a glsl-less contribution as { id, glsl: null, skipBaseCurve: c.skipBaseCurve ?? false, sig: c.skipBaseCurve ? `${id}\n` : "" } so the flag survives, or constrain the type/docs so skipBaseCurve is only legal alongside glsl — today an extension declaring 'built-in transform, no baseline curve' silently renders with the baseline applied.

### `src/extensions/registry.ts`

- **L192 [BUG]** Export-processor 'order' is assigned as the current map size, so re-registering an existing id silently moves that processor to the end of the chain, and an unregister-then-register cycle produces colliding orders — the processor run order (used by runProcessors) drifts across extension enable/disable cycles.
  - _Fix:_ Preserve the existing order on re-registration (const order = s.exportProcessors[c.id]?.order ?? nextOrder) and derive nextOrder from a monotonic counter (e.g. 1 + max existing order) instead of the key count, so removals can never mint a duplicate index. Concrete failure: processors A(0),B(1),C(2); A's extension is disabled (dropped), extension D registers (order = 2, tying C), A re-enables (order = 3) — A now runs last instead of first, changing chained output (e.g. watermark applied after a resizing processor).
- **L234 [BUG]** unregisterProcessingStage deletes the stage's param descriptors BEFORE the ownership check, so a non-owner extension calling it with another extension's stage id wipes that stage's descriptors while the stage itself stays registered.
  - _Fix:_ Check ownership first via getState, and only then unregister params and drop the registry entry: const owner = useRegistry.getState().processingStages[id]; if (!owner || owner.extensionId !== extensionId) return; unregisterStageParams(id); then setState. As written, the still-registered stage loses its ParamDescriptors, so api.params.list(), collectPresetStages, and normalizeParamBag validation for those keys silently degrade.

### `src/extensions/store-ui.ts`

- **L29 [BUG]** The persisted per-extension update-check cache is never invalidated on uninstall or fresh install (only updateExtension resets it), so uninstalling and reinstalling an extension can show a stale "Update available" badge for up to the 30-min TTL, and localStorage entries for long-gone extensions accumulate forever.
  - _Fix:_ Clear the extension's entry (store + LS mirror) in uninstallPlugin and reset it after installFromGitHub (as updateExtension already does); optionally prune LS entries whose id is no longer installed, mirroring pruneSources.

### `src/extensions/ui-kit.tsx`

- **L133 [BUG]** NumberInput fires onChange(0) the moment the field is cleared (Number("") === 0 passes the isFinite guard), so users can never empty the field to retype — the controlled value snaps to 0 mid-edit, and typing a leading "-" in this type="number" input (badInput -> value "") also resets to 0.
  - _Fix:_ Guard the empty/intermediate state: `if (e.target.value === "") return;` (or keep a local string state and only commit on valid parse/blur) before the Number()/isFinite check.

### `src/hooks/use-develop-renderer.ts`

- **L361 [BUG]** Changing developMaxEdge does not take effect 'when a photo is reopened' as its preference hint claims: reopening binds the GPU-resident source uploaded under the old cap, because photoSourceKey (id:rotation) excludes maxEdge and nothing invalidates the source cache on settings change.
  - _Fix:_ Either include maxEdge in the GPU source cache key (old entries age out via LRU), or clear/flush the worker's source cache when developMaxEdge (and highBitDepth) change, or soften the hint to 'Applies to newly decoded photos.'

### `src/hooks/use-loupe-renderer.ts`

- **L95 [BUG]** The load-and-render Promise.all chain has no rejection handler, so if loadPhotoImage or loadSavedEdit rejects (corrupt file, revoked handle) the error is an unhandled rejection and setLoading(false) never runs, leaving the Loupe spinner stuck forever.
  - _Fix:_ Add a .catch that logs the failure and calls setLoading(false) (and optionally surfaces a decode-failed state), mirroring how the develop path degrades.
- **L126 [BUG]** The Loupe renderer never applies the core.hsl style preferences (setHslStyle), while both the Develop view (use-develop-renderer.ts:453) and export (export-image.ts:281) do, so Loupe silently renders different colors than Develop/export whenever Preferences ▸ HSL hueRange/smoothness differ from 100 — despite the file's stated goal of keeping Loupe 'pixel-consistent with Develop'.
  - _Fix:_ After creating the renderer (or before each render), call renderer.setHslStyle(getExtSetting("core.hsl", "hueRange", 100) / 100, getExtSetting("core.hsl", "smoothness", 100) / 100), mirroring export-image.ts.

### `src/modules/develop/DevelopCanvas.tsx`

- **L294 [BUG]** pushCrop's pending requestAnimationFrame is never cancelled on unmount, so a crop write queued mid-drag can fire after the component unmounts and after loadEdit has loaded a different photo, stamping the previous photo's crop into the new photo's params.
  - _Fix:_ Add `useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); pendingCrop.current = null; }, []);` so an unmount (photo/module switch mid-drag) drops the stale write.

### `src/modules/develop/MaskOverlay.tsx`

- **L344 [BUG]** Colour-range eyedropper passes frame-local layout px to sampleLinearRGB, which indexes canvas BUFFER pixels, so the mask colour pick silently samples the wrong pixel whenever displayed size differs from buffer size (i.e. any fit/CSS-zoom view, and off by dpr in ROI zoom).
  - _Fix:_ Map to buffer coords before sampling. In CSS/fit mode: bx = (px - rect.x) / rect.w * cv.width, by = (py - rect.y) / rect.h * cv.height (rect is the full-image rect the overlay receives). Because MaskOverlay can also run in ROI-zoom mode (buffer holds only the visible window at frame size × dpr), the robust fix is to expose ViewportImage's frameToBuffer (or the visible-pixels rect from onLayout) to the overlay render-prop and use it here; also correct the false "render-buffer coords" comment.
- **L743 [BUG]** chooseRetouchSource computes the painted region's extent without the imageAspect x-scaling every other distance in this file applies, so on landscape images the extent is underestimated and the auto heal-source search rings (radius*1.4) can overlap the painted region itself.
  - _Fix:_ Scale the x component into image-height units: `m = Math.max(m, Math.hypot((d.x - cx) * imageAspect, d.y - cy) + d.radius);` so `rad` handed to findHealSource (and the fallback offset `rad * 2.2`) covers the true painted extent.
- **L809 [BUG]** subErase reads maskCompMode via getState during render instead of subscribing, so toggling add/subtract (e.g. via shortcut with the cursor stationary over the canvas) leaves the brush ring in the wrong colour/dash until the next pointer event — inconsistent with brushErase, which IS subscribed reactively three lines of state above.
  - _Fix:_ Subscribe like the sibling state: `const maskCompMode = useDevelopStore((s) => s.maskCompMode);` and use `maskCompMode === "subtract"` in subErase.

### `src/modules/develop/panels/ColorGradingPanel.tsx`

- **L202 [BUG]** Double-click-to-reset on a color wheel first applies and commits the clicked hue/sat twice (each pointerdown moves the value, each pointerup commits) before the reset commit, so undo after a double-click reset restores the accidental click position instead of the pre-click value.
  - _Fix:_ In onPointerDown/onPointerUp, skip applyVec and the commit when e.detail > 1 so a double-click only performs the reset; commitEdit has no no-change dedup to absorb the extra entries.
- **L234 [BUG]** Clearing the hue (or sat, line 249) text input immediately applies 0 to the image because Number("") === 0 passes the Number.isFinite guard, snapping the wheel to hue 0 / sat 0 while the user is mid-edit.
  - _Fix:_ Guard with e.target.value.trim() !== "" before applying, so an emptied field doesn't apply 0 until a real number is typed (or until blur restores the current value).

### `src/modules/develop/panels/CropPanel.tsx`

- **L49 [BUG]** imageAspect is derived from photo.width/photo.height instead of the decoded render buffer's sourceWidth/sourceHeight, so crop aspect presets and constrain-fit math can use a transposed aspect on orientation-divergent decodes.
  - _Fix:_ Derive imageAspect the same way DevelopCanvas.tsx does (sourceWidth/sourceHeight from useDevelopRenderer, lines 240-242), e.g. expose the renderer source size via the develop store or a shared hook and use it here for computeCropForAspect/buildInverseTransform.

### `src/modules/develop/panels/MasksPanel.tsx`

- **L188 [BUG]** Creating a range mask at the MAX_MASKS cap silently does nothing (addMask no-ops in mask-slice.ts:206) yet commitEdit("New Mask") is still pushed, and the "+ Create Mask" button is never disabled at the cap — a hidden limit with no user feedback plus a spurious history entry.
  - _Fix:_ Disable the Create Mask menu (or show a toast) when masks.length >= MAX_MASKS, and only commitEdit when a mask was actually added (e.g. have addMask/addRangeComponent return success).

### `src/modules/develop/panels/PresetsPanel.tsx`

- **L103 [BUG]** Import bypasses the name-collision flow used by Save (commitSave): importing a preset whose name matches an existing one silently creates a second preset with the same name (both the native path at line 103 and the extension-importer path at line 112).
  - _Fix:_ Route imported presets through commitSave (offering Overwrite / Save-as-new) or at minimum apply nextAvailableName(presets, name) before addPreset.
- **L268 [BUG]** The "Update with current settings" dialog shows an editable name field preloaded with the preset name, but onSave discards result.name — presets-store update() keeps the old name, so a user's rename in that dialog is silently dropped.
  - _Fix:_ Either make the name input read-only in update mode (pass a disabled flag to PresetSaveDialog) or apply result.name via renamePreset after the same collision validation used by the rename dialog.

### `src/modules/develop/panels/TransformPanel.tsx`

- **L44 [BUG]** Same transposed-aspect hazard as CropPanel: imageAspect comes from catalog photo.width/height while the render path (DevelopCanvas) uses the decoded buffer's sourceWidth/sourceHeight, so Upright corrections and constrained crop refits can be computed against the wrong aspect when metadata and decode orientation diverge.
  - _Fix:_ Use the renderer's sourceWidth/sourceHeight (as DevelopCanvas.tsx:240 does) for buildInverseTransform, maxCropForTransform, and computeGuidedCorrection instead of photo dimensions.
- **L114 [BUG]** applyUpright sets uprightMode before awaiting computeUpright and has no catch, so a failed/rejected analysis leaves the mode button active with no correction applied and surfaces only as an unhandled promise rejection.
  - _Fix:_ Add a catch that reverts uprightMode to its previous value (or to "off") and surfaces the failure, rather than leaving the UI claiming a correction that was never applied.

### `src/modules/develop/preset-io.ts`

- **L52 [BUG]** pickPresetFile's promise never settles when the user cancels the file picker (only onchange is wired), contradicting the documented "or null if cancelled" contract and leaving handleImport permanently pending.
  - _Fix:_ Also wire input.oncancel = () => resolve(null) (Chromium fires 'cancel' on file inputs) so cancellation resolves null as documented.
- **L72 [BUG]** parseSafelightPreset trusts parsed.params with no shape validation, so a malformed file (e.g. "exposure": "abc" or params as a string) is stored in the presets store and flows through normalizeParams' spread into the renderer as NaN uniforms.
  - _Fix:_ Validate at the import boundary: keep only known DevelopParams keys whose values match the expected type (typeof number for scalars, arrays/objects for complex keys), and reject or empty-string-guard parsed.name ("" currently passes the ?? fallback).

### `src/modules/develop/preset-summary.ts`

- **L48 [BUG]** straighten is enumerated twice in presetFields — as a standalone global-scope scalar (pre-checked when changed) and inside the per-image "Crop & transform" field — so a changed straighten is saved into presets by default, contradicting the stated per-image design, and unchecking "Straighten" still copies it if geometry is checked.
  - _Fix:_ Exclude straighten from the scalar-field loop in presetFields (keep it in PARAM_LABELS for tooltip display of old presets), leaving it solely inside the per-image geometry field; or give the scalar field scope "per-image".
- **L55 [BUG]** PARAM_LABELS omits luminanceNRShadows and luminanceNRHighlights, so both the preset tooltip and the Save Preset dialog silently drop these two Detail-panel sliders — presets saved with them adjusted quietly lose the adjustment.
  - _Fix:_ Add luminanceNRShadows: "Luminance NR shadows" and luminanceNRHighlights: "Luminance NR highlights" to PARAM_LABELS so presetFields/summarizePreset/buildPartialParams cover them.

### `src/modules/export/ExportPanel.tsx`

- **L232 [BUG]** loadPreset never applies preset.colorSpace even though savePreset stores it (line 249) and ExportPreset declares the field; after loading a preset saved with e.g. Adobe RGB, handleExport silently exports in whatever Preferences > Export currently says (line 318).
  - _Fix:_ Add per-session colorSpace state seeded from getSettings().exportColorSpace, set it in loadPreset from preset.colorSpace, and use it in handleExport's settings instead of getSettings().exportColorSpace — or drop colorSpace from ExportPreset if it is intentionally preference-only.
- **L335 [BUG]** The failure status message claims failed photos "could not be decoded", but exportPhotos also pushes filenames into failed[] when the delivery step throws (ZIP add, folder write permission/disk-full), so write errors are misreported as decode errors.
  - _Fix:_ Change the copy to a cause-neutral phrase such as "could not be exported", or have ExportResult distinguish decode failures from delivery failures and report each accurately.

### `src/modules/export/export-image.ts`

- **L301 [BUG]** When the device can't render to a float target, a 16-bit TIFF export silently falls through to the 8-bit path with no user-visible indication — the UI said "16-bit keeps the full editing precision" but the delivered file is 8-bit (the hidden-degrade shape this audit targets).
  - _Fix:_ Propagate the fallback (e.g. a degraded flag/count on ExportResult, or a one-time console.warn plus a note in ExportPanel's status line) so the user learns the output is 8-bit instead of the requested 16-bit.
- **L449 [BUG]** In exportPhotos a throw from renderOne aborts the entire batch: photos already rendered into the ZIP are discarded (the zip download at line 479 is never reached), remaining photos are skipped, and the failed[] report is lost — unlike renderPhotosToBlobs, which wraps renderOne in a per-photo try/catch.
  - _Fix:_ Wrap the renderOne call in a per-photo try/catch (mirroring renderPhotosToBlobs lines 401-404), push photo.filename to failed on throw, and continue the loop so the batch and ZIP survive one bad photo.

### `src/modules/export/zip.ts`

- **L73 [BUG]** Filenames are encoded as UTF-8 but the general-purpose flag bit 11 (EFS, 0x0800) is never set in the local or central headers, so extractors that honor the spec (Windows Explorer, many archivers) decode non-ASCII photo names as CP437 and produce mojibake entry names.
  - _Fix:_ Set flags to 0x0800 in both the local header (offset 6) and central directory header (offset 8) — unconditionally or when nameBytes contains any byte >= 0x80.
- **L114 [BUG]** ZipWriter has no ZIP64 support and no guard on the 32-bit size/offset and 16-bit entry-count fields, so a batch export exceeding 4 GiB (easy with 16-bit TIFFs: ~12 photos at 60 MP) or 65535 entries silently wraps the offsets/counts and produces a corrupt archive.
  - _Fix:_ In add()/blob(), throw (or have exportPhotos fall back to per-file delivery with a status message) when this.offset or an entry size exceeds 0xFFFFFFFF or entries.length exceeds 0xFFFF, rather than writing truncated fields.

### `src/modules/library/InfoPanel.tsx`

- **L68 [BUG]** The histogram effect depends on the whole photo object, so any catalog mutation that replaces this photo's object (rating, flag, color label, keyword edits) triggers a full headless develop-pipeline render even though none of those inputs affect the histogram.
  - _Fix:_ Depend on [photoId, editNonce] only and read the current photo inside the effect via useCatalogStore.getState() (or select just the fields the render needs); photoId is currently redundant next to photo, which is a hint the dep list wasn't settled.

### `src/modules/library/LibraryListRow.tsx`

- **L41 [BUG]** Object URL created from thumbnailBlob inside useMemo is never revoked, leaking a blob URL per row whenever the blob-fallback path is hit (and again on every blob change/remount).
  - _Fix:_ Track the created URL in state/ref via useEffect and call URL.revokeObjectURL on cleanup (only for URLs this component created, not photo.thumbnailUrl owned by the store); or centralize URL creation in the catalog store so components never mint their own.

### `src/modules/library/RenamePhotoDialog.tsx`

- **L40 [BUG]** Filename validation only rejects / and \, so Windows-invalid characters (: * ? " < > |) and trailing dots/spaces pass the dialog's validation and can only fail later at the filesystem rename, with no user-facing error path visible here.
  - _Fix:_ Extend the validation regex to the platform-invalid set (e.g. /[/\\:*?"<>|]/ plus control chars) or share the sanitization rule used by the core renamePhoto path so the dialog and the fs operation agree.

### `src/modules/library/import-photos.ts`

- **L568 [BUG]** rebuildThumbnails does not clear decodeError on a successful rebuild, unlike its two sibling paths (repairMissingPreviews line 520 and reimportPhotos line 678), so a photo that previously failed to decode keeps a stale persisted 'decode failed' marker even after a good preview is built.
  - _Fix:_ Add decodeError: undefined to the updated record in rebuildThumbnails, matching repairMissingPreviews and reimportPhotos (Thumbnail.tsx shows the ⚠ tile off decodeError whenever thumbnailUrl is absent, so the stale flag resurfaces the warning if the preview blob is ever dropped/reloaded).
- **L661 [BUG]** reimportPhotos never recomputes the canonical rotation from the freshly parsed EXIF: photo.rotation is always defined after import, so the '?? orientationToRotation(exif.orientation)' fallback is dead and a file whose EXIF orientation changed on disk (the exact scenario Re-import exists for) comes back sideways.
  - _Fix:_ Extract the manual component against the OLD exif and re-add the new one: const manual = normalizeRotation((photo.rotation ?? orientationToRotation(photo.exif.orientation)) - orientationToRotation(photo.exif.orientation)); const rotation = normalizeRotation(manual + orientationToRotation(exif.orientation)); (e.g. old EXIF 90 → externally rotated to upright with tag cleared: current code bakes 90−0=90 and stores rotation 90, showing the photo sideways).
- **L730 [BUG]** Raising the 'Cached preview resolution' (rawCacheMaxEdge) preference never upgrades existing cache entries: prefetch and 'Cache all now' skip any photo whose cache key is merely present, and Develop's fast path accepts any cached size, so the upgrade branch in load-image.ts is unreachable.
  - _Fix:_ In preDecodeRawsForCache (at least when force:true), read each cached entry's dimensions and include photos whose cached long edge < min(getSettings().rawCacheMaxEdge, photo native long edge); alternatively have Develop pass minEdge derived from the current setting so the load-image.ts:243-247 upgrade path ('upgrade one written under a smaller rawCacheMaxEdge') can actually fire. Today the only escapes are Clear cache or a large export.

### `src/modules/library/netpbm.ts`

- **L139 [BUG]** P1 (plain PBM) parsing reads whitespace-delimited tokens, but the PBM spec explicitly allows no whitespace between pixels, so a packed raster like "0110" is consumed as ONE token, decoded as a single white pixel, and the whole image misparses (usually returning null or garbage).
  - _Fix:_ For P1, read one non-whitespace character per pixel (skipping whitespace/comments between characters) instead of whole tokens; reject characters other than '0'/'1'.

### `src/modules/library/tiff-image.ts`

- **L66 [BUG]** The absurd-dimensions memory guard runs AFTER UTIF.decodeImage has already decoded (and allocated) the full-size page, so the blow-up it exists to prevent has already happened; the dimensions are readable from the IFD tags beforehand (ifdArea does exactly that).
  - _Fix:_ Check the area before decoding: if (ifdArea(page) > 268_435_456) return null; ahead of the UTIF.decodeImage call (keep the post-decode !width/!height check for pages without dimension tags).

### `src/modules/library/use-culling-shortcuts.ts`

- **L82 [BUG]** Hardcoded Backspace fallback for photo.remove fires regardless of user keybindings, so rebinding or unbinding photo.remove in Preferences does not stop bare Backspace from removing photos, contradicting the file's own "All combos are rebindable" comment (Ctrl/Cmd+A and ArrowUp/Down are similarly hardcoded).
  - _Fix:_ Make Backspace the registered default binding for photo.remove in keybindings-store (like the other Library actions) and drop the ?? fallback; alternatively register selectAll and row-navigation as actions too, or soften the comment to say which keys are fixed.

### `src/project/folder-ops.ts`

- **L146 [BUG]** In the FSA (browser) build, moving/renaming a folder silently destroys dot-entries: copyDir skips names starting with '.', then moveOnDisk deletes the source recursively, so skipped hidden files are lost instead of moved.
  - _Fix:_ Either copy dot-entries too in copyDir (they are user data, unlike the root-level .safelight which never appears inside moved subfolders), or delete only the entries that were actually copied instead of a blanket recursive removeEntry.
- **L229 [BUG]** moveFolder (and renameFolder) never check whether the destination folder already exists; the FSA fallback's copyDir({create:true}) silently merges into a same-named folder and overwrites same-named files before deleting the source, while renamePhoto carefully probes existsRel first.
  - _Fix:_ Probe the destination (existsRel or getDirectoryHandle without create) in moveFolder/renameFolder and bail with a user-visible error on collision, matching renamePhoto's guard.
- **L242 [BUG]** movePhotos has no virtual-copy handling: dragging a virtual copy moves the MASTER's file on disk while updating only the copy's record, leaving the master pointing at a missing file; moving a master leaves its copies' relPath/handles stale in-session.
  - _Fix:_ Mirror renamePhoto: skip (or redirect to the master) photos with p.copyOf set, and when moving a master also update all photos whose copyOf === master.id with the new folder/relPath/handles in the same relocatePhotos call.
- **L254 [BUG]** movePhotos leaves the photo's .safelight.json sidecar behind in the old folder, while renamePhoto explicitly carries the sidecar along — the sidecar's whole purpose is to travel next to the image file.
  - _Fix:_ After moving the photo file, best-effort move `${p.filename}${SIDECAR_SUFFIX}` from the old folder to destRel, same as renamePhoto's sidecar block.
- **L412 [BUG]** exportPhotoData writes a virtual copy's sidecar to the same path as its master (`${p.filename}${SIDECAR_SUFFIX}` — copies share filename), so exporting a selection containing a master and its copy silently overwrites one's ratings/edits with the other's (iteration order wins), while `written` counts both.
  - _Fix:_ Skip photos with copyOf set (or export only the master for a shared file, or suffix the copy's sidecar name), and surface that copies were skipped rather than counting a clobbering write as success.

### `src/project/project-storage.ts`

- **L226 [BUG]** In ProjectStorage.open, the `!built` early return is the only new-file exit path that does not bump onProgress, so any file buildPhoto rejects (returns null rather than throwing) leaves importDone permanently short of importTotal and the progress bar never completes.
  - _Fix:_ Bump progress before the early return: `if (!built) { onProgress?.(++newDone, newTotal); return null; }` — matching the abort and catch paths.
- **L433 [BUG]** deletePhoto only cleans up per-photo blobs when this.blobsDir was already lazily opened during THIS session, so blobs persisted in earlier sessions (warp fields etc.) are orphaned on disk when their photo is deleted.
  - _Fix:_ Attempt to open the blobs directory (via this.blobs(), or a non-creating getDirectoryHandle wrapped in try/catch to avoid creating it on projects that never used blobs) instead of gating on the session-local cached handle.

### `src/project/project-store.ts`

- **L201 [BUG]** The persisted library-folder filter is keyed by handle.name (folder basename), so two projects with the same folder name on different paths share the key — contradicting the adjacent comment 'a different project never inherits a stale folder path' and restoring a possibly nonexistent folder filter in the other project.
  - _Fix:_ Key by the same identity recent.ts uses: `nativePathOf(handle) ?? handle.name`, so Electron projects are keyed by absolute path.
- **L271 [BUG]** `buf = []` runs unconditionally BEFORE the generation check, so the following flush() always drains an empty buffer — the 'drain any photos buffered since the last frame' comment is false and stragglers are only saved by the later reconcile/finalize happening to include them.
  - _Fix:_ Reorder to match the comments: `if (gen !== openGen) { buf = []; return; } flush();` so the discard happens only on cancellation and flush actually drains stragglers.

### `src/project/recent.ts`

- **L45 [BUG]** Every operation opens a fresh IDBDatabase via openDB() and never calls db.close(), leaking connections per call (addRecentProject additionally opens one per trimmed entry); undead connections will block any future DB_VERSION bump's upgrade in this multi-window app (no onblocked handling).
  - _Fix:_ close() the db in a finally at each call site (or cache one connection module-wide with an onversionchange → close handler), and pass the open db into removeRecentProject during the trim loop instead of reopening per entry.
- **L104 [BUG]** migrateLegacy re-runs whenever the recents store is empty and never clears the legacy localStorage path or legacy IDB record, so a user who removes every recent project sees the old 'last project' resurrect on the next welcome-screen load — the 'one-time' migration re-arms forever.
  - _Fix:_ After a successful migration, localStorage.removeItem(LEGACY_LS_PATH) and delete the legacy store's 'last' record (or write a migrated flag) so removal of all recents stays removed.

### `src/raw/cache-bridge.ts`

- **L19 [BUG]** The cache worker has no onerror/onmessageerror handling: if the worker fails to boot the `ready` promise never settles and every cache call (readCachedPreview, cachedKeys, ...) awaits forever — raw-cache's try/catch cannot rescue a never-settling promise, so photo loads hang instead of falling back to a fresh decode; pending map entries also leak if postMessage throws.
  - _Fix:_ Attach `worker.onerror` that rejects `ready` and all `pending` entries (and resets `worker`/`ready` so the next call retries or degrades to null); wrap the postMessage in send() in try/catch and delete the pending entry on throw.

### `src/raw/decode-pool.ts`

- **L56 [BUG]** warmDecodePool caches the first warming promise and ignores the `size` argument on every later call, so a request to grow the pool beyond the first call's size silently no-ops despite the signature implying otherwise.
  - _Fix:_ Track the warmed size and re-run ensurePool when a larger size is requested (e.g. `if (!warming || size > poolSize) warming = ensurePool(size);`), or drop the parameter since all callers use the default.

### `src/raw/libraw-wasm-adapter.ts`

- **L132 [BUG]** libraw-wasm's open() transfers (detaches) the caller's ArrayBuffer to its worker, so when a libraw decode fails after open(), decodeRawToFloat's in-house TIFF/CFA fallback runs on a detached buffer and silently returns null — the documented libraw→in-house fallback chain is effectively dead, degrading those RAWs to the embedded preview.
  - _Fix:_ In decodeRawFloatViaLibRaw (and extractColorTemperature, which also detaches its caller's buffer), pass a copy to open(): `await raw.open(new Uint8Array(buffer.slice(0)), ...)`. Alternatively have decode.ts hand the adapter a sliced copy and keep the original for the fallback.
- **L210 [BUG]** The inferred-dimensions recovery accepts w*h up to totalPx + w, so the subsequent pixel loop can read up to one full row past the end of the pixels array, writing NaN into the last row of the returned float image.
  - _Fix:_ After choosing w, derive `h = Math.floor(totalPx / w)` and require `w * h <= totalPx` (or clamp the copy loop to `Math.min(n, Math.floor(pixels.length / stride))` and zero-fill the remainder).

### `src/raw/libraw.ts`

- **L39 [BUG]** getLibRaw permanently caches the absence of a module: if a libraw build assigns globalThis.__safelightLibRaw after the first decode attempt (the exact runtime-registration flow the header documents), it is silently ignored for the rest of the session unless it also calls registerLibRaw.
  - _Fix:_ Only cache a found module: when `globalThis.__safelightLibRaw` is absent return null without setting `cached` (the lookup is trivially cheap), or document that registerLibRaw is the sole supported entry point.

### `src/raw/raw-cache.ts`

- **L9 [BUG]** The header comment claims the cache key includes lastModified so 'any change to the source file automatically misses the cache', but rawCacheKey only uses relPath + fileSize + rotation — an in-place modification that preserves byte size serves stale cached pixels.
  - _Fix:_ Add file.lastModified to the key (bump the version prefix to v4 so old entries age out) — callers already hold the File/CatalogPhoto — or, if size-based invalidation is the deliberate compromise, correct the comment so it stops promising invalidation the key cannot deliver.
- **L41 [BUG]** The cache key omits lastModified even though the file header documents it as part of the key, so a source file edited in place with the same byte size (e.g. in-place EXIF/metadata edits) keeps serving the stale cached preview unless the user explicitly runs Reimport.
  - _Fix:_ Add lastModified to rawCacheKey (bump the version prefix, thread file.lastModified through the three call sites in load-image.ts / import-photos.ts), or if deliberately excluded, correct both comments to state the real invalidation contract.

### `src/rendering/render-bridge.ts`

- **L172 [BUG]** dispose() sets this.disposed = true before calling this.post({cmd:"dispose"}), and post() early-returns when disposed, so the dispose command is never sent — the line is dead code and the worker-side renderer.dispose() GL cleanup never runs (only worker.terminate() tears things down).
  - _Fix:_ Send the dispose message before setting the flag (this.post({cmd:"dispose"}); this.disposed = true; this.worker.terminate();) — noting terminate() immediately after may still preempt it — or delete the dead post and rely explicitly on terminate() as the teardown.
- **L519 [BUG]** getRenderBridge() discards the useSettings.subscribe unsubscriber (unlike unsubStages/unsubPipeline), so disposeRenderBridge() leaks the settings subscription; each dispose/recreate cycle accumulates another live listener whose closure keeps pushing cache budgets at the current singleton.
  - _Fix:_ Store the return value in a module-level `unsubSettings` (like unsubStages/unsubPipeline) and call+null it in disposeRenderBridge().

### `src/rendering/render-worker.ts`

- **L181 [BUG]** The 'High bit depth' preference has no effect on the Develop renderer: the render worker hardcodes highBitDepth: true, and the init message carries only width/height, so the setting never reaches the worker.
  - _Fix:_ Thread the setting into the worker (the worker cannot read localStorage): add highBitDepth to the init message in render-bridge.ts and pass getSettings().highBitDepth from the main thread, or add a dedicated set message applied before the next setImage. The PreferencesDialog hint at line 1583 claims 'Turn off to halve texture memory. Applies when Develop is reopened.' — currently false in the worker-rendered Develop view.
- **L241 [BUG]** If the capture case throws (e.g. renderer.render() fails), the error falls to the generic catch which posts an untargeted "error" response, so the bridge's captureResolvers entry for that reqId is never settled and any extension awaiting capture() (before/after overlays) hangs forever.
  - _Fix:_ Add a per-case try/catch that responds with the blank 1x1 fallback bitmap (already used for the !renderer path) or a dedicated captureError carrying reqId, mirroring the thumbnailError pattern.
- **L302 [BUG]** In renderThumbnail (and renderThumbnailFromSource at lines 413-416), the global contributed-params bag is only restored on the success path; if tr.render() throws, the catch responds with thumbnailError but leaves the thumb renderer holding the per-render bag, so every subsequent thumbnail renders with the wrong photo's stage params (the exact stale-stage-bag wrong-colors failure mode).
  - _Fix:_ Wrap the render in try/finally: `if (hadBag) tr.setContributedParams(msg.contributedParams!); try { tr.render(); } finally { if (hadBag) tr.setContributedParams(latestParamBag); }` in both handlers.
- **L430 [BUG]** analyzeUpright silently `break`s when the renderer or downscaled pixels are unavailable, so RenderBridge.computeUpright's promise never settles and TransformPanel's `await getRenderBridge().computeUpright(mode)` hangs forever (same unsettled-promise class the author explicitly fixed for thumbnails with thumbnailError).
  - _Fix:_ Always respond — post an { type: "upright", result: {straighten:0,perspectiveV:0,perspectiveH:0} } (or a dedicated uprightError) on the !renderer and !pixels paths, and settle uprightResolve on the generic "error" response too. Also note render-bridge.ts keeps a single uprightResolve slot, so a second concurrent computeUpright clobbers (permanently hangs) the first — use a reqId map like capture/bindSource.

### `src/rendering/thumbnail-renderer.ts`

- **L21 [BUG]** The cached main-thread histogram renderer singleton never recovers from WebGL context loss, so after a GPU reset/driver hiccup every Library histogram silently comes back blank until app restart.
  - _Fix:_ Attach a webglcontextlost listener to the created canvas (or check renderer/gl.isContextLost() at the top of renderPhotoHistogram) and null out histCtx so the next call rebuilds the context instead of rendering into a dead one.

### `src/rendering/webgl/renderer.ts`

- **L1344 [BUG]** The 8-bit bitmap upload path ignores maxEdge entirely: the ImageBitmap is uploaded at full size (unlike the float path which caps via capFloatToEdge and the srgb16 path which caps opt-in), so an oversized bitmap can exceed MAX_TEXTURE_SIZE and — per this file's own maxTextureEdge doc (line 1200) — texImage2D fails and the frame renders black.
  - _Fix:_ When Math.max(image.width, image.height) exceeds min(maxEdge-cap policy, MAX_TEXTURE_SIZE), draw the bitmap into a downscaled OffscreenCanvas before upload (or at minimum clamp to maxTextureEdge), mirroring the float path's cap.
- **L1425 [BUG]** bindSource restores width/height/linear/applyBaseCurve but not the maxEdge the entry was uploaded with (SourceEntry doesn't record it), so a cache-hit render silently uses whatever maxEdge the last setImage happened to set — the render-worker's renderThumbnailFromSource message even carries a maxEdge (render-worker.ts:90) that is ignored on the bindSource path, i.e. a stale hidden output cap exactly like the JPEG-export bug class.
  - _Fix:_ Store maxEdge in SourceEntry at upload time and restore it in bindSource (or add a maxEdge parameter to bindSource and thread msg.maxEdge through render-worker's bindSource/renderThumbnailFromSource handlers).
- **L1434 [BUG]** sourceEpoch is bumped on every bindSource — including the re-bind of the *same displayed texture* at the end of a prefetch (uploadSource with bind=false bumps twice) — so the prepass srcSig (`e${sourceEpoch}`, line 2129) changes and expensive prepasses like denoise are needlessly recomputed for an unchanged image after every neighbour prefetch, defeating the prepass cache.
  - _Fix:_ Key the prepass srcSig by currentSourceKey when set (e.g. `k${key}`) and only fall back to the epoch for legacy setImage uploads; or skip the epoch bump when bindSource re-binds the texture that is already active.
- **L1477 [BUG]** estimateSourceBytes counts every non-linear source at 8 bytes/px whenever the GPU supports norm16, so plain 8-bit bitmap uploads (RGBA8, actually 4 B/px) are double-counted and the LRU source cache silently holds half as many bitmap sources as the configured budget allows.
  - _Fix:_ Record the actual bytes-per-pixel of the upload path taken in setImage (e.g. set a lastUploadBpp field in each branch) and use it in uploadSource's bytes estimate instead of inferring from haveNorm16.
- **L1747 [BUG]** syncPipeline clears passPrograms and prepassSigs when the stage signature changes but never clears failedPrepass, so a prepass stage whose GLSL was fixed (extension update or dev-folder reload changes sSig) stays permanently disabled until the renderer is reconstructed.
  - _Fix:_ Add this.failedPrepass.clear() inside the sSig-changed branch so a stage-set change retries compilation.
- **L1907 [BUG]** Stage textures beyond MAX_STAGE_TEXTURES are silently dropped by the break, leaving the overflow samplers at default unit 0 — they then sample uImage (the photo) as LUT data, producing garbage output with no diagnostic; the analogous silent break for prepass stages beyond MAX_PREPASS_STAGES (line 2554) likewise degrades without warning.
  - _Fix:_ For overflow bindings, bind ensureDummyStageTex() to a safe unit (or set the sampler to a unit holding the dummy) and console.warn once per session that the stage-texture/prepass capacity was exceeded.
- **L2380 [BUG]** readDownscaledPixels overrides crop and transform to identity but not uViewport, so with a zoom ROI active (setViewport) the upright/line-detection readback renders only the last frame's zoom window while the caller (analyzeUpright, render-worker.ts:431) interprets it as the whole frame.
  - _Fix:_ Set uViewport to (0,0,1,1) alongside the crop/transform overrides and restore it from this.roi in the restore block.
- **L2683 [BUG]** dispose() never deletes the six histogram resources (histTex/histFbo, histTexF/histFboF, histTexD/histFboD), leaking GL textures and framebuffers each time a renderer is disposed and recreated on the same context.
  - _Fix:_ In dispose(), delete each of histTex/histTexF/histTexD (gl.deleteTexture) and histFbo/histFboF/histFboD (gl.deleteFramebuffer) when non-null.

### `src/state/accessibility.ts`

- **L183 [BUG]** The Interface-level reduceMotion setting is applied only by the accessibility extension's overlay (settings-store explicitly defers it here), so disabling the core.accessibility extension silently makes Preferences ▸ Interface ▸ "Reduce motion" a no-op with no UI indication.
  - _Fix:_ Either apply the manual reduceMotion class from settings-store's applySideEffects (leaving only the OS OR-in to the extension), or disable/annotate the Interface toggle when the accessibility extension is off.

### `src/state/catalog-store.ts`

- **L397 [BUG]** rotatePhotos persists rotation via putPhoto directly and never calls emitMetadataChange, unlike every rating/label/flag/keyword change routed through commit(), so extensions that persist metadata externally (e.g. XMP sidecar writers) silently miss rotations.
  - _Fix:_ After the Promise.all in rotatePhotos, call emitMetadataChange with the updated photo records (same shape as commit()); consider the same for setCopyName if copy names should reach sidecars.

### `src/state/develop-slices/mask-slice.ts`

- **L76 [BUG]** applyOwnedValues in clear mode strips blocks by patching { hsl: undefined } through updateMask's spread, which leaves an own enumerable `hsl: undefined` property on the mask that structured-clone persistence (IndexedDB) stores as an explicit undefined key rather than deleting it — unlike updateMaskBag, which properly deletes keys.
  - _Fix:_ In updateMask (or a dedicated clear path), delete keys whose patch value is undefined instead of spreading them, mirroring updateMaskBag's undefined-deletes semantics, so persisted masks stay minimal as the updateMaskBag comment intends.
- **L213 [BUG]** addMask and addSpot still broadcast an edit-update via pushEdit even when the MAX_MASKS/MAX_RETOUCH cap made the set() a no-op, and the caps themselves fail silently — the gesture that created the mask/spot just vanishes with no UI feedback.
  - _Fix:_ Track whether the cap rejected the add (e.g. compare lengths after set) and skip pushEdit on rejection; surface the cap to the caller (return boolean or toast) so the canvas overlay can tell the user why nothing appeared.

### `src/state/develop-store.ts`

- **L114 [BUG]** Undo/redo (moveHistory) persists the new history cursor but never regenerates the edited grid thumbnail nor calls emitEditCommit, so the Library thumbnail and any extension-persisted edit (e.g. XMP sidecar) stay stale at the pre-undo look while the stored edit state points elsewhere.
  - _Fix:_ After persisting the cursor in moveHistory, call regenerateEditedThumbnail(photoId, history[newIndex].params, asShotTemperature, history[newIndex].paramBag) and emitEditCommit with the updated EditState, mirroring commitEdit.
- **L174 [BUG]** loadEdit resets previewParams and guidedEditing when switching photos but leaves mask/retouch selection state (selectedMaskId, selectedComponentId, selectedSpotId, hoveredMaskId, activeTool) pointing at ids from the previous photo, so the new photo can open with a dangling selection or an active mask/retouch tool armed against nonexistent objects.
  - _Fix:_ In both loadEdit branches also reset selectedMaskId: null, selectedComponentId: null, selectedSpotId: null, hoveredMaskId: null (and consider activeTool: "none"), or add a resetTransient helper on the mask slice invoked from loadEdit.
- **L264 [BUG]** applyPreset's contract accepts Partial<DevelopParams> but the implementation replaces the whole params via normalizeParams(partial), so any caller passing a true partial silently resets every unspecified core adjustment to defaults — including temperature to 6500K instead of the photo's as-shot WB (asShotTemperature is sitting right there in the store).
  - _Fix:_ Merge inside the store — normalizeParams({ ...s.params, ...params }) with temperature falling back to asShotTemperature when the partial omits it — instead of relying on the sole caller (PresetsPanel's `effective()`) to pre-merge; or narrow the signature to full DevelopParams so partials can't slip through.

### `src/state/keybindings-store.ts`

- **L44 [BUG]** Default combos "Ctrl+Shift+[" / "Ctrl+Shift+]" for surround darker/lighter can never match on US-layout keyboards because with Shift held e.key is "{" / "}", and unlike the brush-feather bindings these actions have no altDef alias.
  - _Fix:_ Add altDef: "Ctrl+Shift+{" to develop.surroundDarker and altDef: "Ctrl+Shift+}" to develop.surroundLighter (same shifted-character alias pattern already used for brush.featherDown/featherUp and brush.flowDown/flowUp).
- **L297 [BUG]** findConflicts() ignores altDef aliases, so a live built-in alias (e.g. Ctrl+Y for develop.redo while unrebound) can collide with a user-assigned combo without the Shortcuts UI flagging it; matchAction() then silently resolves the press by KEY_ACTIONS order.
  - _Fix:_ For each action with no override and an altDef, add a second entry with combo = altDef to the conflict scan (same id, same category), so alias collisions are surfaced.

### `src/state/presets-store.ts`

- **L27 [BUG]** Presets are loaded once at import and never sync via the storage event, unlike settings-store and keybindings-store, so with a detached Develop window each window holds a stale copy and the last window to add/rename/delete a preset silently clobbers the other window's changes.
  - _Fix:_ Add an initPresets() that listens for the storage event on "safelight-presets" and setState's the parsed list, mirroring initSettings()/initKeybindings(), and call it at boot.
- **L36 [BUG]** saveToStorage() has no try/catch, unlike every other persisted store in this directory, so a localStorage quota failure (plausible with large paramBag presets) throws from inside the zustand set() updater, aborting the state update and propagating an exception to the UI handler.
  - _Fix:_ Wrap the setItem in try/catch (matching settings-store's `try { localStorage.setItem(KEY, ...) } catch {}`), or at minimum move saveToStorage outside the set() updater and surface the failure.

### `src/state/thumbnail-loader.ts`

- **L34 [BUG]** setThumbnailLoader() force-resets `running = false` while an old pump() may still be mid-await; a new requestThumbnail then starts a second concurrent pump, and when the old pump's finally block later runs it resets `running = false` again, allowing a third concurrent pump alongside the second.
  - _Fix:_ Don't reset `running` in setThumbnailLoader (the gen bump already terminates the old loop); or track the running pump's generation so a stale pump's finally block only clears `running` when it is still the current pump.
- **L94 [BUG]** pump() checks the generation token only at the top of each loop iteration, so a blob resolved after setThumbnailLoader() swapped projects is still pushed into the NEW project's pending batch and merged into the new catalog under the old photo id.
  - _Fix:_ Re-check `gen === myGen` after the `await loader(id)` resolves, before pushing to `pending` (mirror the guard reloadThumbnail already has: `if (!blob || gen !== myGen) return`).

### `src/ui/ViewportImage.tsx`

- **L309 [BUG]** Eyedropper clicks on the letterbox/surround are forwarded to onPick with out-of-image buffer coordinates (negative or > buffer size), unlike the zoom path which guards with pointOnImage — samplers receive coordinates outside the image.
  - _Fix:_ Guard the pick path the same way: if (onPick && !zoomGesture) { if (!pointOnImage(clientX, clientY)) return; ... } (or clamp bx/by to [0, buf-1] if edge-sampling is desired). Same consideration applies to the onPickDrag onDown path in onPointerDown.
- **L356 [BUG]** Releasing any non-Space key while Space is still held clears the zoom gesture: keyup of e.g. 'A' has code!=='Space' and ctrlKey false, so setCanvasZoomGesture(false) fires even though Space is down, silently ending overlay passthrough/pan mid-gesture.
  - _Fix:_ Track which gesture keys are actually down (Space / Ctrl / Meta) and only clear the gesture when none of them remain held, e.g. keep a Set of pressed gesture keys updated on keydown/keyup and call setCanvasZoomGesture(set.size > 0).
- **L507 [BUG]** No onPointerCancel handler: if a pan or pick-drag is interrupted (pointercancel from touch, capture loss, OS gesture), downRef/pickDragRef stay set — subsequent hover moves pan the image with no button pressed, and onPickDrag.onUp() is never delivered, leaving the picker stuck active.
  - _Fix:_ Add onPointerCancel={onPointerUp} (or a dedicated handler that clears downRef, pickDragRef, dragging, and pending RAF pan) on the frame div.

### `src/ui/components/CurveEditor.tsx`

- **L134 [BUG]** handlePointerDown has no e.button check, so right- and middle-clicks on the curve canvas add/drag control points (Histogram's equivalent handler correctly filters to button 0).
  - _Fix:_ Add `if (e.button !== 0) return;` at the top of handlePointerDown, matching Histogram.tsx's onPointerDown.
- **L267 [BUG]** The In/Out number fields are fully controlled with no local editing state, so the field can never be cleared or hold intermediate text while retyping (the empty-string guard snaps it back to the rounded current value on every keystroke), unlike Slider's `editing` buffer.
  - _Fix:_ Mirror Slider.tsx: keep a local `editing: string | null` state per field while focused, apply the parsed value onChange, and clear the buffer on blur.

### `src/ui/components/Histogram.tsx`

- **L132 [BUG]** When data goes null (photo closed/deselected), displayRef keeps the last photo's bins and the draw path renders the stale histogram indefinitely because the null-data branch only runs while displayRef is empty.
  - _Fix:_ Clear displayRef.current (or fade bins to zero) when data becomes null so the canvas draws the empty state instead of the previous image's histogram.

### `src/ui/components/PreferencesDialog.tsx`

- **L194 [BUG]** The hand-maintained search index has drifted from the rendered fields: 'Show photos in subfolders' (Library), 'Only verified extensions' (Extensions) and 'TIFF bit depth' (Export) exist as controls but are absent from their sections' items/keywords, so searching for them reports 'No settings match'.
  - _Fix:_ Add "Show photos in subfolders" to the Library items, "Only verified extensions" to the Extensions items, and "TIFF bit depth" (plus a 'tiff' keyword) to the Export section. Longer term, derive the index from the rendered fields (as extension sections already do from their declarative fields) so the two can't drift; note the PrefSetting doc comment (line 109) already promises 'label + hint + option labels' but the settings() helper indexes labels only.
- **L1285 [BUG]** The 'Cached preview resolution' hint claims 'Live edits always render full resolution', but Develop renders live edits from the cached preview capped at rawCacheMaxEdge — only export bypasses the cap.
  - _Fix:_ Correct the hint to state actual behavior, e.g. 'Long-edge cap of cached previews. Develop edits render from this cached preview; exports larger than the cap re-decode the full RAW.' (Or, if full-res live editing is intended, make Develop pass a minEdge derived from the photo's native size / developMaxEdge — a much larger change.)
- **L1294 [BUG]** Raising 'Cached preview resolution' never takes effect for already-cached photos: the cache key has no size component, Develop accepts any-size entries, and 'Cache all now' (force) skips every photo whose key is already present regardless of its stored size.
  - _Fix:_ In preDecodeRawsForCache, when opts.force is set, don't skip present keys blindly: read each cached entry's dimensions and re-decode when Math.max(w,h) < Math.min(getSettings().rawCacheMaxEdge, native long edge). Alternatively, invalidate cache entries smaller than the new cap when rawCacheMaxEdge increases.
- **L1424 [BUG]** StoredCatalogsField's cleanup-only mountedRef effect leaves the ref permanently false after React 18 StrictMode's dev double-mount, so deleting a stored catalog sticks at 'Deleting…' and the row never disappears in dev builds.
  - _Fix:_ Set the ref in the effect body: useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []); — or drop the ref and use the same `cancelled` closure pattern the scan effect already uses.
- **L2035 [BUG]** The update-check hint says the app 'checks the GitHub releases API once on launch', but UpdateBanner also re-polls every 3 hours while the app stays open (its own comment notes the launch-only behavior is the OLD behavior).
  - _Fix:_ Update the hint to 'checks the GitHub releases API on launch and every few hours while the app is open' so the privacy-relevant claim matches the actual network behavior.

### `src/ui/components/Thumbnail.tsx`

- **L72 [BUG]** URL.createObjectURL is called inside a useMemo with no matching revokeObjectURL, and the identical 5-line fallback block is duplicated in LibraryListRow.tsx — every mount/remount of a cell whose photo has a thumbnailBlob but no thumbnailUrl leaks an object URL that pins the blob for the session.
  - _Fix:_ Extract a shared hook (e.g. useThumbnailUrl(photo)) that returns photo.thumbnailUrl when present, otherwise creates an object URL in a useEffect and revokes it on cleanup/blob change; use it in both Thumbnail.tsx and LibraryListRow.tsx. Grid virtualization remounting cells makes the per-mount leak repeatable on large catalogs.

### `src/ui/components/TopBar.tsx`

- **L117 [BUG]** The one-time reconnect gesture listener is gated by a ref that is never reset, so if needsReconnect becomes true a second time in the same session (failed reconnect, permission revoked again) the first-click auto-reconnect never re-arms.
  - _Fix:_ Reset armed.current = false when needsReconnect goes false (e.g. in the effect's else branch or cleanup after a successful reconnect), or drop the ref and rely on the { once: true } listener plus effect cleanup keyed on needsReconnect.

### `src/ui/components/ViewMenu.tsx`

- **L22 [BUG]** View and Layout top-bar dropdowns close only on outside pointerdown, not on Escape, while the app's other status-bar popovers (DisplayTransformControl, SurroundControl) register pushEscapeHandler — inconsistent keyboard behavior for the same UI pattern.
  - _Fix:_ In both ViewMenu and LayoutMenu, also register pushEscapeHandler(() => setOpen(false)) while open, mirroring DisplayTransformControl/SurroundControl.

### `src/update/UpdateBanner.tsx`

- **L108 [BUG]** The Close button's tooltip says the banner 'will remind you again next launch', but the 3-hour poll re-surfaces the same un-skipped version within the current session because dismiss(false) records nothing and the interval unconditionally calls setUpdate(info).
  - _Fix:_ Track the closed version in component state (e.g. a sessionDismissed ref) and have the poll callback skip setUpdate when info.version matches it; the module header comment ('it won't reappear for the same version') then also becomes accurate for Close.

### `src/update/update-checker.ts`

- **L150 [BUG]** checkForUpdateFull picks the first release matching the channel (GitHub orders by publish date, not version), so on the 'all' channel a later-published pre-release of an older line (e.g. a 1.1.x beta published after 1.2.0) becomes 'best', and since isNewer then fails the user is told 'up-to-date' while a genuinely newer stable release exists.
  - _Fix:_ Select the maximum-version matching release instead of the first: reduce over the filtered list with isNewer/compareSemver on tag_name.


## Tier P — Render-path / pixel-affecting (report-only, needs in-app verification) (19)

### `src/rendering/color-space.ts`

- **L304 [BUG]** embedJpeg emits the new ICC APP2 segments immediately after SOI and moves ALL pre-existing header segments (including JFIF APP0 / EXIF APP1) after them, violating the JFIF/EXIF requirement that APP0/APP1 immediately follow SOI — strict parsers and metadata tools can misidentify the file or its EXIF.
  - _Fix:_ Insert the ICC APP2 segments after any leading APP0/APP1 segments instead of directly after SOI: split `kept` at the first non-APP0/APP1 marker and concat([SOI, leadingApp01, ...segs, remainingKept, rest]).

### `src/rendering/content-aware-fill.ts`

- **L99 [BUG]** randomKnownCenter's give-up fallback returns the clamped image centre without checking the hole mask, so for a large/central hole (or when 48 random tries miss) the NN field is seeded with source coordinates inside the hole itself, letting PatchMatch propagate synthetic hole pixels as "known" texture.
  - _Fix:_ On fallback, pick a guaranteed-known pixel instead: scan outward from the centre (or keep a precomputed list of !hole indices inside the [P, W-P) x [P, H-P) band) and return the first non-hole coordinate; also guard the E-step/random-search rejection already excludes holes, so only this seed path needs fixing.

### `src/rendering/curve.ts`

- **L129 [BUG]** buildRGBCurveLUT composes three separately quantized 8-bit LUTs (base -> rgb -> channel), so intermediates are rounded to 8 bits twice; where the Adobe base curve crushes shadows this collapses distinct input levels and posterizes dark tones versus composing the evaluators in float.
  - _Fix:_ Build float evaluators once (makeCurveEvaluator for base/rgb/red/green/blue) and compute out[i] = round(redEval(rgbEval(baseEval(i/255))) * 255) directly, quantizing only the final value; apply the same to buildMaskCurveLUT (rgb -> channel).

### `src/rendering/webgl/mask-coverage.ts`

- **L26 [BUG]** coverageSignature omits imageAspect even though the bake depends on it (rx = radius/aspect), and the renderer caches purely by this signature, so an aspect change with unchanged dabs (e.g. preview-to-full decode with divergent orientation, width/height swap) leaves a stale atlas with wrongly stretched dabs.
  - _Fix:_ Fold the aspect into the cache key: either add an aspect parameter to coverageSignature or have updateCoverageTexture compare `${sig}@${aspect.toFixed(4)}` against prevSig.
- **L56 [BUG]** bakeCoverage silently drops brush items beyond four, and the renderer's `this.maskChannelOf[c.id] ?? 0` fallback then renders the dropped component with the FIRST component's coverage — nothing upstream enforces the cap (MAX_BRUSH_MASKS is defined in catalog/types.ts but imported nowhere).
  - _Fix:_ When a brush component has no channelOf entry, force its coverage to 0 (e.g. upload uCompMode subtract-noop or skip the component) instead of defaulting to channel 0, and enforce MAX_BRUSH_MASKS at mask/component creation in the UI so the user is told rather than silently degraded.
- **L56 [HARDCODED]** The four-channel atlas capacity is a bare literal here while the same conceptual constant exists as MAX_BRUSH_MASKS / MAX_RETOUCH_BRUSH in catalog/types.ts and MAX_RBRUSH in the GLSL — three copies that can drift, and the types.ts constant is currently imported by no one.
  - _Fix:_ Import MAX_BRUSH_MASKS in mask-coverage.ts (items.slice(0, MAX_BRUSH_MASKS)) and derive the GLSL #define from the same constant where the shader source is assembled, so the capacity has one source of truth.

### `src/rendering/webgl/renderer.ts`

- **L837 [BUG]** Coverage-atlas rebuilds are gated on coverageSignature(items) alone, but bakeCoverage also depends on the image aspect (dab x-radii are divided by it, mask-coverage.ts:86); if imageWidth/Height change without the dabs changing (setParams before decode arrives, or a fallback preview replaced by an orientation-divergent full decode), the stale wrong-aspect bake is kept and brush masks/retouch render distorted.
  - _Fix:_ Fold the aspect into the signature, e.g. const sig = `${aspect.toFixed(5)}|${coverageSignature(items)}`; (compute aspect before the early-return).
- **L1887 [BUG]** Grain "Color" slider is a silent no-op: uGrainColor is never added to the uniform-location list in cacheUniformsFor, so u.uGrainColor is undefined and gl.uniform1f(undefined, gr.color) is ignored, leaving the shader's uGrainColor at 0 in every render path (develop, thumbnails, export).
  - _Fix:_ Add "uGrainColor" to the names array in cacheUniformsFor next to "uGrainRoughness".
- **L2520 [BUG]** prepassActive only treats non-zero *numbers* in the param bag as activity, so a prepass stage driven by a boolean or vector param (or one whose non-zero defaults simply aren't materialized in the bag) never runs its passes — its inline GLSL silently receives stageResult = raw source while its scalar uniforms still bind non-default values.
  - _Fix:_ Also treat `v === true` and non-empty arrays as active, and compare against each pass binding's declared default (a value differing from default = active) rather than against literal zero.
- **L2582 [BUG]** Prepass pass-program cache key uses fragmentSource.length as the only per-pass discriminator, so two passes of the same stage with equal-length sources (the classic case: separable H/V blur passes differing only by swapped .x/.y — identical length) silently reuse the first pass's compiled program.
  - _Fix:_ Include the pass index (or simpleHash(pass.fragmentSource), already imported) in the key: `${this.stageSig}|${stage.stageId}|${passIdx}`.
- **L2661 [BUG]** The patched-source target (developedTex) is always RGBA8/UNSIGNED_BYTE, so the moment any retouch spot exists the entire develop chain (pass 2 reads it as uImage with uLinear unchanged, prepasses like denoise read it too, and captureFloatFrame's 16-bit export drives this same path) sources from an 8-bit quantized, [0,1]-clamped copy of a 16F linear RAW — silent banding/HDR loss triggered by one heal spot.
  - _Fix:_ Allocate developedTex as RGBA16F when haveColorBufferFloat (mirroring allocTarget), keeping RGBA8 as the fallback; verify generateMipmap on RGBA16F works with EXT_color_buffer_float present (it becomes color-renderable + filterable) with a probe like the norm16 one. Pixel-affecting: report-only, verify in app.

### `src/rendering/webgl/shader-compiler.ts`

- **L66 [BUG]** rewriteGlsl namespaces stage uniform/helper names with raw substring replaceAll (no word boundaries), so a uniform key that is a substring of another identifier (or of another key) corrupts the generated GLSL in the LIVE injection path.
  - _Fix:_ Replace with identifier-boundary regex replacement (new RegExp(`\\b${escapeRegExp(key)}\\b`, 'g')) and process keys longest-first; apply the same fix to the inline replaceAll loops in renderer.ts buildPassFragment (lines 434-435) and buildStageInjection (lines 533-535, 565).
- **L76 [BUG]** extractHelperNames' return-type regex omits mat2 (and uint), so a stage helper returning mat2 is never namespaced and collides with any same-named helper from another extension or the main shader.
  - _Fix:_ Broaden to mat[234] (and add uint|uvec[234]|ivec[234]|bvec[234] for completeness): /\b(?:float|int|uint|bool|void|[ibu]?vec[234]|mat[234])\s+([a-zA-Z_]\w*)\s*\(/g.

### `src/rendering/webgl/shaders.ts`

- **L150 [SLOP]** The uSharpenViz declaration comment enumerates only modes 1-3, but main() also implements mode 4 (Color-NR chroma preview at line 1529), so the uniform's documented contract is stale.
  - _Fix:_ Add '4 = color-NR chroma preview (luma flattened, chroma amplified)' to the enumeration at the declaration.
- **L185 [SLOP]** Uniforms uHealFill/uHaveHealFill (185-186) and uRetouchRadius (181) are declared but never read anywhere in the GLSL, while renderer.ts still computes and uploads them every frame (silent no-ops since getUniformLocation returns null) — and the CONTENT_AWARE_HEAL flag can never do anything because its shader consumer is missing.
  - _Fix:_ Remove the three uniform declarations plus the renderer's location lookups/uploads and updateHealFill scaffolding, or wire the shader side back up before CONTENT_AWARE_HEAL is ever enabled.
- **L239 [SLOP]** Nine GLSL functions in FRAGMENT_SHADER are dead — defined but never called anywhere in the shader or by injected core stages: rollHi (239), whitesWeight (354), blacksWeight (361), applyWhitesRGB (432), applyBlacksRGB (451), rgb2YCbCr (496), yCbCr2rgb (504), retouchCovAt (730, used only by dead inpaintBrush), inpaintCircle (741), inpaintBrush (762).
  - _Fix:_ Delete the dead functions (GLSL compilers already eliminate them, so output is provably unchanged); if inpaintCircle/inpaintBrush are intended for the CONTENT_AWARE_HEAL revival, move them to a comment-referenced branch or the feature's own injection.
- **L325 [SLOP]** applyHighlightsRGB's header comment says the recovery knee 'slides to 0.30 at H=-1' but the code uses 0.25 — a stale constant left from a retune.
  - _Fix:_ Update the comment to 0.25 (or name the constant once and reference it).
- **L947 [BUG]** applyMaskLinear's contract comment claims mask Highlights/Shadows behave 'exactly like the global slider', but the global path was replaced by the integrated filmic-shoulder block (lines 1249-1308) while masks still call the old applyHighlightsRGB/applyShadowsRGB (different knee: mix(1.0,0.25,amt) vs mix(0.85,0.15,-H)), so a full-coverage mask at -100 no longer matches global -100.
  - _Fix:_ Either port the integrated shoulder math into applyMaskLinear so mask and global sliders match again, or correct the comments to state the mask path deliberately keeps the legacy recovery curves (report-only; pixel-affecting change needs in-app verification).
- **L987 [DUP]** applyMaskDisplay duplicates main()'s Whites/Blacks/Dehaze/Texture display-stage blocks verbatim (~40 lines) instead of sharing helpers like applyVibSat does, and its cross-reference comments already point at stale line numbers, showing the copies are drifting.
  - _Fix:_ Extract shared GLSL helpers (e.g. applyWhitesDisplay(c, amt), applyBlacksDisplay, applyDehazeDisplay(c, amt, uv), applyTextureDisplay) called from both main() and applyMaskDisplay with identical math, and drop the line-number comments.


## Tier A — Safe cleanups (auto-fixable) (84)

### `electron/main.cjs`

- **L229 [SLOP]** The local `const net` in extensionConnectHosts shadows the Electron `net` module imported at the top of the file — harmless today, but any future net.fetch call inside this function would silently break.
  - _Fix:_ Rename the local to `declared` (or `networkPerms`).
- **L604 [DUP]** The lazy-load + 1s-debounced-persist JSON disk-cache pattern is copy-pasted four times in main.cjs (loadSearchDisk/persistSearchDisk, loadRegistryDisk/persistRegistryDisk, loadOgDisk/persistOgDisk, loadIconDisk/persistIconDisk), ~90 lines that differ only in file path, backing map, and entry validator.
  - _Fix:_ Add one small factory, e.g. `diskCache(fileName, validateEntry)` returning { load(map), persist(map) } with the shared lazy-read guard and debounced unref'd write, and instantiate it four times. Keeps the per-cache validators as the only bespoke code.
- **L784 [DUP]** The three stale-cache fallback returns in searchExtensionsLive (lines 784, 788, 792) return hit.items raw, while the fresh-cache hit path (lines 768-771) re-decorates each item with cachedThumbnail — the divergence means rate-limited/offline responses serve stale thumbnails even when the icon/og caches have since resolved better ones, despite cachedThumbnail being a purely local lookup.
  - _Fix:_ Extract a `withFreshThumbs(items)` helper that maps cachedThumbnail over the items and use it in all four return sites.
- **L1277 [HARDCODED]** The 36px title-bar overlay height (itself derived from the renderer's 38px bar) is hardcoded in two places — the window:setTitleBarOverlay IPC handler and titleBarOpts — so a bar-height change requires editing both and they can silently drift.
  - _Fix:_ Hoist `const TITLEBAR_OVERLAY_HEIGHT = 36;` (with the 38px-bar comment) next to titleBarOpts and reference it in both sites.

### `src/catalog/edit-params.ts`

- **L14 [DUP]** loadSavedParams duplicates loadSavedEdit's storage read, stack check, and normalization; the two copies can drift (e.g. if the currentIndex/stack handling ever changes in one).
  - _Fix:_ Implement loadSavedParams as: return (await loadSavedEdit(photoId, asShotTemperature)).params; (the extra normalizeParamBag call is cheap and the result is discarded).

### `src/catalog/load-image.ts`

- **L270 [DUP]** The embedded-preview upright dance (createImageBitmap with imageOrientation:none → previewUprightRotation from master EXIF → rotateBitmap → close original if replaced) is copy-pasted three times: loadPhotoImage lines 202-210 and 270-276, and loadPhotoBitmap lines 333-339.
  - _Fix:_ Extract a helper, e.g. async function uprightPreviewBitmap(preview: Blob, photo: CatalogPhoto): Promise<ImageBitmap>, and use it at all three sites.

### `src/catalog/orient.ts`

- **L130 [HARDCODED]** rotateBlob re-encodes rotated grid thumbnails at JPEG quality 0.85 while thumbnails are generated at 0.8 everywhere else (import-photos.ts:102, edited-thumbnail.ts:125/168) — the same conceptual constant (thumbnail JPEG quality) is defined in four places and has already drifted, with no comment justifying the divergence.
  - _Fix:_ Extract a single shared THUMBNAIL_JPEG_QUALITY constant and use it at all four sites; if 0.85 is deliberately higher to limit second-generation loss on re-encode, keep two named constants with a comment stating that intent.

### `src/extensions/Markdown.tsx`

- **L14 [SLOP]** Header comment claims indented code blocks are supported, but renderBlocks has no indented-code branch — 4-space-indented code is folded into a paragraph with whitespace collapsed.
  - _Fix:_ Either add an indented-code branch (4+ leading spaces outside other blocks) or correct the comment to "fenced code".

### `src/extensions/SettingsFieldList.tsx`

- **L28 [HARDCODED]** labelCls/inputCls exported here are byte-identical to private consts redeclared in PreferencesDialog.tsx — the same conceptual style constants exist in two places and can silently drift.
  - _Fix:_ Have PreferencesDialog import labelCls/inputCls from SettingsFieldList (or move both to a shared styles module) so there is one source of truth.
- **L44 [SLOP]** anyFieldMatches is exported "(for nav filtering)" but is never imported anywhere in the codebase — a dead export suggesting the Preferences nav filtering it was written for never got wired up.
  - _Fix:_ Either use it in the Preferences nav filtering it documents, or delete the function (and drop the export on fieldMatches, which is only used internally).
- **L157 [DUP]** The toggle-switch markup (h-4 w-7 pill + travelling knob) is hand-rolled six times across core — twice in this file, once in ExtensionManagerPanel, twice in PreferencesDialog — while ui-kit.tsx already exports the canonical Toggle with identical classes.
  - _Fix:_ Extract one shared Toggle (hoist it out of ui-kit.tsx into its own module to avoid the ui-kit→SettingsFieldList import cycle) and use it at all six sites.

### `src/extensions/devtools/DevExtensionsTab.tsx`

- **L48 [DUP]** The dev-folder controls block (read-only path input + Choose/Change + Clear + Rescan + status/error text) is duplicated nearly line-for-line between DevExtensionsTab.tsx (48-87) and DevSettings.tsx (46-86), and the two copies have already drifted (different description text, different Rescan labels, DevSettings adds a Clear tooltip the tab lacks).
  - _Fix:_ Extract a shared DevFolderControls component (e.g. in dev-folder area) taking a size/density variant, and render it from both DevSettings and DevExtensionsTab so the copy and behavior can't drift.

### `src/extensions/devtools/detach.ts`

- **L20 [HARDCODED]** The dock-panel id "core.devtools" is defined as PANEL_ID here but re-typed as a raw string in builtin.tsx twice (registerPanel id and the Ctrl+Alt+I togglePanel handler); if the registration id changes, detach/re-dock silently toggles a non-existent panel.
  - _Fix:_ Export the panel id from one module (e.g. export const DEVTOOLS_PANEL_ID from detach.ts or a small ids.ts) and import it in builtin.tsx for registerPanel and togglePanel.

### `src/extensions/dock.tsx`

- **L26 [SLOP]** The PanelErrorBoundary class is inserted in the middle of the import block (imports continue at line 52 with `import { create } from "zustand";`), breaking the file's own top-of-file import grouping convention — an insertion artifact.
  - _Fix:_ Move the PanelErrorBoundary class definition below the last import so all imports are contiguous at the top of the file.
- **L431 [DUP]** initModule's flush-on-module-switch re-implements the exact localStorage serialization block from scheduleSave (same layoutKey + JSON payload of rails/floating/zOrder/collapsed), two copies that can drift if the persisted shape changes.
  - _Fix:_ Extract a `saveLayout(state: Pick<DockState, "module" | "rails" | "floating" | "zOrder" | "collapsed">)` helper used by both scheduleSave's timeout body (lines 129-142) and initModule's flush.

### `src/extensions/store-ui.ts`

- **L26 [SLOP]** Stale comment claims a "6h TTL in checkExtensionUpdate" but the actual constant (loader.ts UPDATE_CHECK_TTL) is 30 minutes, deliberately "kept short" — the two descriptions of the same constant have drifted.
  - _Fix:_ Reword the comment to not restate the duration ("the TTL in checkExtensionUpdate"), or reference UPDATE_CHECK_TTL by name so there is one source of truth.
- **L97 [SLOP]** categoryFor's manifestCategories parameter is dead — no caller passes it (both call sites pass only topics), so the manifest `categories` field documented as "Preferred over repo topics" never actually influences store categories.
  - _Fix:_ Either wire manifest categories through the search results / registry index into the call sites, or drop the parameter until the data is plumbed.

### `src/extensions/trust.ts`

- **L195 [DUP]** Each reactive hook (useIsVerified, useReviewedFor, useVerificationStatus, useBannedReason) re-implements its non-hook counterpart's logic verbatim against a TrustState instead of sharing a state-taking helper, so the two copies of the verification/ban logic can drift.
  - _Fix:_ Extract pure helpers taking the list, e.g. verificationStatusIn(list: TrustList, repo, version) and bannedReasonIn(list, repo), then implement verificationStatus() as verificationStatusIn(useTrust.getState().list, ...) and useVerificationStatus() as useTrust((s) => verificationStatusIn(s.list, ...)); same for the verified/reviewed/banned pairs.

### `src/extensions/types.ts`

- **L315 [DUP]** ExportProcessorField is a verbatim 34-line copy of the SettingsField union (same four variants, same fields), which can silently drift when one gains a variant or field.
  - _Fix:_ Alias it: export type ExportProcessorField = SettingsField; (keeps the distinct name for API docs while guaranteeing the shapes stay identical).
- **L428 [HARDCODED]** The texture-format union is defined twice and has already drifted: TextureRequirement.format omits "r16f" while StageTextureData.format (and the renderer's upload switch) support it, so a stage cannot declare the r16f textures the runtime accepts.
  - _Fix:_ Define one exported union (e.g. export type StageTextureFormat = "rgba8" | "r8" | "rgba16f" | "r16f") and use it in both TextureRequirement and StageTextureData so the two lists cannot diverge; renderer.ts already handles all four.

### `src/hooks/use-develop-renderer.ts`

- **L274 [DUP]** The bypass-aware contributed-params block (bypassParamBag + denoiseBag spread into setContributedParams) is copy-pasted three times in this file (sendImage, renderResident, and the params effect), so a future tweak to bypass handling can silently miss one call site.
  - _Fix:_ Extract a local helper, e.g. const pushContributed = (bag, params, bypassed) => bridge.setContributedParams({ ...bypassParamBag(bag, bypassed), ...denoiseBag(applyPanelBypass(params, bypassed)) }), and use it at all three sites.

### `src/hooks/use-keyboard-shortcuts.ts`

- **L201 [SLOP]** Four switch cases (panels.toggle, develop.undo, develop.redo, develop.reset) call e.preventDefault() again even though it is already called unconditionally for every matched action at line 184 ('Matched = handled').
  - _Fix:_ Delete the redundant per-case e.preventDefault() calls at lines 201, 208, 212, and 216.

### `src/hooks/use-loupe-renderer.ts`

- **L21 [HARDCODED]** Loupe decode resolution is hardcoded to 6144 and ignores the user's developMaxEdge setting, so with the 8192 preference the 1:1 Loupe silently shows downscaled pixels while Develop shows full resolution.
  - _Fix:_ Derive the cap from settings, e.g. const maxEdge = Math.max(getSettings().developMaxEdge, 6144) at upload time, instead of a fixed module constant — this is exactly the hidden-ceiling shape (UI promises 1:1, a constant quietly caps it).

### `src/modules/develop/DevelopCanvas.tsx`

- **L66 [SLOP]** Comment "// Get RGB to hue" is a garbled restatement of the function name rgbToHue directly beneath it, adding nothing — out of step with this file's constraint-comment style.
  - _Fix:_ Delete the comment (or replace with something load-bearing, e.g. the output range/space: "display-space hue in degrees, 0 for neutrals").
- **L188 [HARDCODED]** The operative core.hsl defaults (hueRange 100, smoothness 100, pickerSensitivity 0.5) are inline fallbacks repeated at four call sites plus the settings registration, and getExtSetting never consults the registered default — so a change to the registration silently desynchronizes picker, renderer, and export weight shaping.
  - _Fix:_ Export shared constants (e.g. `export const HSL_SETTING_DEFAULTS = { hueRange: 100, smoothness: 100, pickerSensitivity: 0.5 }` next to the core.hsl registration) and use them both in the builtin.tsx setting descriptors and as the getExtSetting fallback at every call site.
- **L269 [DUP]** The source-UV <-> screen mapping (mat3Apply through forward/inv plus crop plus rect scaling) is implemented three times — DevelopCanvas.overlayState toScreen/toImage/radiusToScreen, MaskOverlay toSource/toScreen/radiusToScreen (lines 172-183), and GuidedOverlay uvToScreen/screenToUV (lines 34-51) — and the DevelopCanvas comment itself notes it is "the same source-UV <-> screen mapping the built-in mask/heal overlay uses".
  - _Fix:_ Extract one helper (e.g. makeUvScreenMapper(rect, crop, forward, inv) in src/rendering/transform.ts or a small develop util) returning { toScreen, toImage, radiusToScreen }; keep GuidedOverlay's 0..1 clamp as an explicit option since that divergence is deliberate.

### `src/modules/develop/MaskOverlay.tsx`

- **L457 [DUP]** The 9-line addBrushDab payload literal is copy-pasted three times (shift-line dabs, single-click dab, drag dabs), identical except x/y — a divergence in any one copy (e.g. dropping flow) would be an invisible bug.
  - _Fix:_ Add a local `const makeDab = (x: number, y: number, erase: boolean): BrushDab => ({ x, y, radius: st.brushSize, erase, feather: st.brushFeather, opacity: st.brushOpacity, flow: st.brushFlow });` (reading st at call time) and use it at all three sites.
- **L870 [HARDCODED]** Linear-mask boundary guide lines extend a fixed 400px each side of the endpoints, so on frames wider than ~800px across the gradient the dashed boundary lines visibly stop mid-canvas.
  - _Fix:_ Derive the extension length from the viewport instead of a constant, e.g. `const ext = Math.hypot(rect.w, rect.h);` (frame diagonal always spans the visible area) and use `* ext` in place of `* 400`.

### `src/modules/develop/panels/HSLPanel.tsx`

- **L37 [SLOP]** The useExtSettings subscription is dead: `view` is captured once in the useState initializer and nothing else in the render reads core.hsl settings, so the claimed "re-render when preferences change" has no observable effect (a changed Preferences > HSL defaultView never reaches a mounted panel).
  - _Fix:_ Either remove the useExtSettings call (if defaultView is intentionally mount-time only), or read the setting reactively (derive view from the subscribed value until the user overrides it locally) so the comment matches behavior.

### `src/modules/develop/panels/HistogramPanel.tsx`

- **L21 [HARDCODED]** ZONE_PARAM re-declares the tonal parameter ranges (exposure -5..5, others -100..100) that are already declared in BasicPanel's basicSliders — two copies of the same conceptual limits that can drift if a range ever changes.
  - _Fix:_ Move the per-param min/max into a single shared table (e.g. alongside DEFAULT_DEVELOP_PARAMS or develop-adjustments) and have both BasicPanel and HistogramPanel read from it.
- **L50 [SLOP]** Two `as never` casts at the typed setParam boundary (lines 50 and 91) that are avoidable with the NumericParamKey mapped-type pattern already used in BasicPanel.
  - _Fix:_ Type ZONE_PARAM's key field as NumericParamKey (the mapped type from BasicPanel.tsx:16) so DevelopParams[K] resolves to number and both setParam calls typecheck without casts; hoist that type to catalog/types if shared.

### `src/modules/develop/panels/PresetSaveDialog.tsx`

- **L88 [DUP]** Five preset dialogs copy the same modal scaffolding (fixed overlay, click-outside cancel, footer button row) with an unintentional-looking divergence in Escape handling: Delete/Overwrite use window-level keydown listeners, Rename/Move only handle Escape while their input is focused, and the Save dialog cannot be dismissed with Escape at all.
  - _Fix:_ Extract a shared modal-shell component (overlay + click-outside + window-level Escape → onCancel) and use it in all five dialogs, which also fixes the Save dialog's missing Escape.

### `src/modules/develop/panels/PresetsPanel.tsx`

- **L184 [HARDCODED]** The Export button always exports the full live params under the fixed name "preset" (file preset.safelight.json), so every exported file is identically named and re-importing yields a preset literally called "preset" regardless of what the user was exporting.
  - _Fix:_ Derive the export name from context (e.g. the current photo's filename or a small name prompt), and/or add an "Export" entry to the preset context menu so saved presets can be exported under their own name and group.

### `src/modules/develop/panels/WhiteBalancePanel.tsx`

- **L39 [DUP]** The 15-line pipette/picker SVG is copy-pasted verbatim between WhiteBalancePanel (lines 39-53) and HSLPanel (lines 68-82).
  - _Fix:_ Extract a shared PickerIcon (or EyedropperIcon) component under src/ui/components and use it in both panels.

### `src/modules/export/export-image.ts`

- **L26 [HARDCODED]** The export-format union is defined twice — ExportFormat here and the identical ExportFormatPref in settings-store.ts — and the copies can drift; the `format as ExportPreset["format"]` cast in ExportPanel.tsx line 246 exists only to bridge the duplicate types.
  - _Fix:_ Define the union once (e.g. keep ExportFormat in export-image.ts and alias ExportFormatPref = ExportFormat in settings-store.ts, or vice versa to avoid an import cycle), then delete the now-unnecessary cast in ExportPanel.tsx.

### `src/modules/library/CopySettingsDialog.tsx`

- **L61 [SLOP]** fieldCount is computed by subtracting the bag flag from selected.size and immediately adding it back, which is just selected.size written in a convoluted way.
  - _Fix:_ Replace with fieldCount: selected.size and delete scalarCount (it has no other use).

### `src/modules/library/LibraryListRow.tsx`

- **L10 [DUP]** colorDot label-to-class map and the thumbUrl useMemo block are verbatim copies of the labelDot map and thumbUrl memo in Thumbnail.tsx; the label map also exists a third time as LABEL_SWATCHES in LibrarySidebar.tsx.
  - _Fix:_ Export one labelClass map (e.g. from @/catalog/types or a ui/labels module) and one usePhotoThumbUrl hook (which would also be the place to fix the revoke leak), and consume them from Thumbnail, LibraryListRow and LibrarySidebar.

### `src/modules/library/LibrarySidebar.tsx`

- **L228 [DUP]** KeywordFilterField reimplements KeywordEditor's entire keyword-input widget (catalog keyword count map, suggestion filtering/sorting, ArrowUp/Down/Enter/comma/Backspace key handling, outside-click close, chip list, dropdown markup) with only cosmetic divergences (slice(0, 6) vs slice(0, 8)).
  - _Fix:_ Extract a shared KeywordInput component (props: activeKeywords, onAdd, onRemove, maxSuggestions) plus a useKeywordCounts(photos) hook; use them in KeywordEditor, KeywordFilterField and KeywordsPanel.

### `src/modules/library/MetadataPanel.tsx`

- **L10 [DUP]** Human-readable byte-size formatting is implemented three times (formatSize here, formatBytes in PreferencesDialog.tsx:1396, mb in DevToolsPanel.tsx:713) with diverging behavior: this copy caps at MB, so a multi-GB video/RAW displays as e.g. "3276.8 MB", and its KB rounding differs from the Preferences formatter.
  - _Fix:_ Move PreferencesDialog's formatBytes (the most complete implementation, with GB/TB tiers) into a shared util (e.g. src/ui/format.ts) and use it in MetadataPanel; DevToolsPanel's fixed-unit `mb` can stay if the fixed unit is deliberate for log alignment.

### `src/modules/library/import-photos.ts`

- **L141 [DUP]** The scalar linear-to-sRGB / sRGB-to-linear transfer functions are reimplemented at least nine times across src (twice inside this file alone), with no shared module, so the copies that must exactly match the shader can silently drift.
  - _Fix:_ Create one shared module (e.g. src/rendering/srgb.ts) exporting srgbEncode(v) and srgbDecode(v) and import it from all nine sites; several comments already say 'matches the renderer's transfer functions', which is exactly the invariant a single source of truth would enforce.
- **L320 [HARDCODED]** RAW_MIME has drifted from RAW_EXTENSIONS in raw-preview.ts: the later-added ".raw" and ".mdc" extensions have no MIME entry, so those files get mimeType "" and the Info panel shows nothing — exactly the drift the two hand-maintained lists invite.
  - _Fix:_ Add ".raw" and ".mdc" entries, and guard against future drift by deriving one list from the other (e.g. build RAW_EXTENSIONS from Object.keys of a single map that carries the MIME per extension, exported from raw-preview.ts).
- **L503 [DUP]** The decode → canonical-rotation/bake-rotation → createThumbnail → swap/width/height → updated-record block is copy-pasted nearly verbatim in repairMissingPreviews (503-521), rebuildThumbnails (558-575) and reimportPhotos (661-679), with a partial fourth copy in buildPreviewBlob (306-310); the copies have already diverged (rebuildThumbnails forgot decodeError: undefined; reimportPhotos reads exif vs photo.exif).
  - _Fix:_ Extract one helper, e.g. async function bakeThumbnailUpdate(photo, decoded, exif = photo.exif): Promise<{ thumb, width, height, rotation }>, and have all four call sites consume it (pass the fresh exif in reimportPhotos); the decodeError divergence disappears with it.
- **L764 [HARDCODED]** preDecodeRawsForCache's concurrency fallback '|| 2' contradicts both the adjacent comment ("match the persistent decode pool size (default 3)") and DEFAULT_SIZE = 3 in decode-pool.ts; decodePoolSize() returns 0 until the pool has warmed, so an early background pass silently runs at 2 workers instead of the intended 3.
  - _Fix:_ Export DEFAULT_SIZE from src/raw/decode-pool.ts and use it as the fallback: Math.min(decodePoolSize() || DEFAULT_SIZE, todo.length), so the comment, the pool, and this pass share one source of truth.

### `src/modules/library/netpbm.ts`

- **L82 [HARDCODED]** The max-decodable-pixels guard 268_435_456 is defined independently in netpbm.ts and tiff-image.ts; the same conceptual limit in two files can drift.
  - _Fix:_ Hoist a single exported MAX_DECODE_PIXELS constant (e.g. in a shared decode-limits module or raw-preview.ts) and use it in both decoders.

### `src/modules/library/raw-preview.ts`

- **L7 [SLOP]** The module header still says full RAW decoding hasn't landed ("Until full RAW decoding lands (libraw/WASM, Phase 3)"), but libraw-wasm decoding shipped long ago (decodeRawToFloat/decodeRawToBitmap are the primary path in import-photos.ts) — the comment misstates this module's current role as the embedded-preview extractor/fallback.
  - _Fix:_ Update the header to describe the current role: extracts the largest decodable embedded JPEG used for fast grid previews and as the fallback when the libraw decode fails or is skipped (previewSource "embedded"/"auto").

### `src/modules/loupe/LoupeCanvas.tsx`

- **L11 [SLOP]** LoupeCanvas is dead code: LoupeView.tsx says the Loupe module was removed, and no file in src/ imports LoupeCanvas, yet this full component (and its sole consumer relationship with use-loupe-renderer.ts, which is likewise imported nowhere else) was left behind.
  - _Fix:_ Delete src/modules/loupe/LoupeCanvas.tsx and src/hooks/use-loupe-renderer.ts (keeping the LoupeView.tsx tombstone if desired), or re-wire them if the Loupe removal was not meant to orphan them.

### `src/project/folder-ops.ts`

- **L71 [DUP]** The absolute-path join with trailing-slash strip (`rootPath.replace(/[/\\]+$/, "") + "/" + rel`) is re-implemented three times in this file (existsRel, moveOnDisk, revealPhoto) and again as private helpers in native-fs.ts (join) and working-dir.ts (stripSlash/catalogJsonIn).
  - _Fix:_ Export the existing join() helper from native-fs.ts (e.g. as joinNativePath) and use it at all three folder-ops call sites and in working-dir.ts.

### `src/project/project-storage.ts`

- **L70 [HARDCODED]** SIDECAR_SUFFIX and the PhotoSidecar shape are duplicated from folder-ops.ts (acknowledged as 'kept in sync there' to dodge an import cycle) — the two copies can drift, and a cycle-free home is trivially available.
  - _Fix:_ Move SIDECAR_SUFFIX and a shared PhotoSidecar type to a leaf module (e.g. src/project/sidecar.ts) imported by both folder-ops.ts and project-storage.ts — neither would then import the other.
- **L88 [SLOP]** OpenedProject.newPhotos is a dead field: its only consumer (project-store.openProject) deliberately uses opened.photos instead, so the field is returned but never read anywhere, and its doc comment ('candidates for background pre-decode') describes a use that no longer exists.
  - _Fix:_ Drop newPhotos from the OpenedProject interface and return value (keep the local newPhotos array, which is still used for removedCount and the scheduleSave condition).

### `src/raw/cache-worker.ts`

- **L101 [DUP]** downsampleFloatRGBA in cache-worker.ts (lines 101-130) is byte-for-byte identical to capFloatToEdge in webgl/renderer.ts (lines 201-230) — the same 30-line box-average loop, signature, and return shape under two names in two worker bundles.
  - _Fix:_ Move the function to a shared pure module (e.g. src/rendering/downsample.ts) and import it from both worker bundles; the near-identical Uint8 variant downsampleRGBA (renderer.ts:147-170) could optionally reuse the same core loop.
- **L162 [SLOP]** Unnecessary `as unknown as ArrayBuffer` double-cast when passing a Uint16Array to gzip(BufferSource), while the sibling call site in the same file passes the identical value with no cast.
  - _Fix:_ Drop the cast: `const gz = await gzip(u16);`.

### `src/raw/decode-pool.ts`

- **L87 [SLOP]** disposeDecodePool is exported but never called anywhere in the repo, and its implementation would misbehave if it ever were used: queued acquireInstance waiters are dropped (their promises hang forever) and in-flight instances released afterwards push terminated-worker instances back into `free`.
  - _Fix:_ Delete the unused export, or if kept for lifecycle symmetry, reject/flush `waiting` and add a generation counter so releaseInstance discards instances from a disposed pool.

### `src/raw/libraw-wasm-adapter.ts`

- **L28 [DUP]** The Tanner Helland blackbodySrgb fit plus the 240-step log-Kelvin search (~40 lines) is duplicated verbatim between libraw-wasm-adapter.ts (estimateKelvinFromMul, lines 28-67) and catalog/exif.ts (estimateKelvinFromNeutral, lines 404-444), and the fit constants are restated a third time in auto-adjust.ts blackbodyLinear.
  - _Fix:_ Extract a shared module (e.g. src/rendering/blackbody.ts) exporting blackbodySrgb(kelvin) and estimateKelvinFromGains(gR, gB); exif.ts's 1/neutral inputs and libraw's cam_mul inputs both reduce to the same green-normalised gain ratio, so the two callers become one-line wrappers. auto-adjust.ts's blackbodyLinear can then be built from the shared fit so the constants exist once.
- **L75 [HARDCODED]** extractColorTemperature keeps a 1 MiB minimum-size floor while decodeRawFloatViaLibRaw was deliberately lowered to a 64 KiB floor for small legacy RAWs (old Canon CRW, Kodak KDC, some 3FR) — those files decode fine but silently never get an as-shot colorTemperature at import, so downstream WB defaults to 6500K.
  - _Fix:_ Extract one shared constant (e.g. `const MIN_RAW_BYTES = 64 * 1024;`) and use it in both functions.

### `src/raw/pixels.ts`

- **L118 [DUP]** The scalar sRGB transfer functions (linearToSrgb / srgbToLinear, IEC 61966-2-1) are reimplemented in at least 10 places across src/, including twice inside import-photos.ts, with no shared module.
  - _Fix:_ Create a shared module (e.g. src/rendering/srgb.ts) exporting srgbToLinear(v) and linearToSrgb(v) (plus a clamped variant), and import it from cache-worker.ts, pixels.ts, load-image.ts, auto-adjust.ts, sample-pixel.ts, renderer.ts, import-photos.ts, MasksPanel.tsx, and color-space.ts. All call sites use identical constants today, so consolidation is a pure refactor; it also removes the drift risk between the CPU paths and the GPU shader math they must mirror.
- **L160 [SLOP]** toRGBAFloat's rationale comment asserts "normalizePlane clamps clipped channels at 1.0", directly contradicting normalizePlane's actual behavior and its own doc comment that values above 1.0 are deliberately preserved.
  - _Fix:_ Reword the toRGBAFloat comment to say clipped sites sit at/near the normalized ceiling (>= CLIP), not that normalizePlane clamps them; confirm which contract the CLIP=0.9995 detection is meant to rely on.

### `src/rendering/auto-adjust.ts`

- **L150 [HARDCODED]** The tint-solve constant 250 is the hand-inverted form of the tint gain model `1 - (tint / 150) * 0.6` defined 30 lines above (and mirrored in the WB shader); if either 150 or 0.6 changes, 250 silently drifts and Auto WB tint solves against the wrong model.
  - _Fix:_ Define one constant, e.g. `const TINT_GAIN_SLOPE = 0.6 / 150;`, use `1 - tint * TINT_GAIN_SLOPE` in gainsFor and `(1 - wantGainG) / TINT_GAIN_SLOPE` in the solve so both sides derive from the same source of truth.

### `src/rendering/render-bridge.ts`

- **L310 [SLOP]** StageTextureData is referenced via inline `import("@/extensions/types")` type syntax four times (lines 310, 457, 474, 488-491) even though the file already has a top-level `import type { ProcessingStageContribution } from "@/extensions/types"`, inconsistent with the file's own import convention.
  - _Fix:_ Add StageTextureData to the existing top-level `import type { ProcessingStageContribution } from "@/extensions/types"` and replace the four inline import() type references.

### `src/rendering/render-worker.ts`

- **L164 [HARDCODED]** The thumb-renderer cache fraction (budget / 4) is written independently in ensureThumbRenderer (line 164) and the setCacheBudget handler (line 394), and the thumbnail JPEG quality default 0.8 is likewise duplicated in both thumbnail handlers (lines 306 and 418) — copies that can silently drift.
  - _Fix:_ Hoist module constants, e.g. `const THUMB_CACHE_FRACTION = 0.25;` and `const DEFAULT_THUMB_JPEG_QUALITY = 0.8;`, and use them at all four sites.
- **L210 [SLOP]** Self-labelled TEMP debug block posts retouch diagnostics over the worker error channel on every setParams, spamming the bridge's onError callback whenever any retouch spots exist.
  - _Fix:_ Delete the TEMP block (lines 210-223); setParams should only forward params to the renderer.
- **L410 [DUP]** The renderThumbnail (289-317) and renderThumbnailFromSource (403-427) handlers share a ~12-line identical tail (setAsShotTemperature → setParams → contributed-bag swap → render → bag restore → convertToBlob → respond/respondThumbError), acknowledged by the 'See the renderThumbnail handler' comment, so a future fix applied to one tail can miss the other.
  - _Fix:_ Extract a local helper, e.g. finishThumbRender(tr, msg) that applies params/bag, renders, restores the bag, and settles the request via convertToBlob/respondThumbError; both case blocks call it after their divergent setImage/bindSource preamble.

### `src/rendering/webgl/renderer.ts`

- **L73 [SLOP]** Import statements appear mid-file (after the PipelineProgram interface and constants), inconsistent with the file's own convention of a single top import block (lines 6-48).
  - _Fix:_ Move the four imports up into the top import block.
- **L201 [DUP]** capFloatToEdge in renderer.ts is a line-for-line copy of downsampleFloatRGBA in cache-worker.ts (~30 lines of box-average Float32 RGBA downsampling), and downsampleRGBA at renderer.ts:147 is a third variant of the same algorithm for Uint8.
  - _Fix:_ Move the Float32 box-downsample into one shared module (e.g. src/rendering/downsample.ts) exporting downsampleFloatRGBA(data, W, H, maxEdge), and import it from both the render worker and the RAW cache worker (both are bundled module workers, so a shared import is fine). Optionally parameterize the element type to also fold in downsampleRGBA.
- **L363 [DUP]** The GLSL helper block (luma, srgbToLinear, linearToSrgb, linearToSrgbU) is pasted verbatim into three separate shader sources — PASS_SHARED_GLSL in renderer.ts, the main fragment shader in shaders.ts, and the extension-stage preamble in shader-compiler.ts — so a fix in one copy silently diverges the other render paths.
  - _Fix:_ Export one shared GLSL snippet constant (e.g. `export const COLOR_HELPERS_GLSL` in shaders.ts) and interpolate it into shaders.ts's fragment source, renderer.ts's PASS_SHARED_GLSL, and shader-compiler.ts's stage preamble. This matters beyond tidiness: extension stages and prepasses must produce bit-identical encode/decode to the main pass, and the documented API contract in extensions/types.ts (lines 109-110, 490) names these helpers.
- **L529 [DUP]** The helper-namespacing block in buildStageInjection (extract names, replaceAll helper names then uniform keys with prefixes) duplicates the same ~7-line block in buildPassFragment (lines 430-437); the only divergence is the stage path additionally rewriting texture keys.
  - _Fix:_ Extract a shared namespaceHelpers(helpers, uniforms, hPfx, uPfx, textures?) helper (natural home: shader-compiler.ts beside rewriteGlsl) and call it from both sites.
- **L2228 [DUP]** The histogram readback target setup (create texture, texImage2D, three texParameteri, create FBO, attach, unbind) is repeated three times in computeHistogram — histFboD (2228-2239), histFbo (2261-2272), histFboF (2292-2303) — differing only in internal format/type and the member fields assigned.
  - _Fix:_ Extract a private helper, e.g. `createReadbackTarget(internalFormat, format, type): { tex, fbo }`, and call it lazily for the three targets; the divergence surface (format constants) becomes two arguments instead of three pasted blocks.
- **L2619 [SLOP]** runPrepasses recomputes prepassSig with identical arguments even though the same value was already computed into `sig` at line 2565 and nothing it depends on changed in between.
  - _Fix:_ Replace with this.prepassSigs.set(stage.stageId, sig);

### `src/rendering/webgl/shader-compiler.ts`

- **L23 [DUP]** hashStageId reimplements the identical hash loop as simpleHash in the same file, differing only by the .slice(0,4) — and the 4-char truncation needlessly raises the odds that two stage IDs collide and their namespaced uniforms silently merge.
  - _Fix:_ Define hashStageId as simpleHash(stageId).slice(0, 4) (identical output), and consider dropping the slice (full base36 hash, max 7 chars) to shrink the collision window.
- **L149 [SLOP]** compileShaderSource, buildComposedFragment, getActiveStages, compilerSignature, CompiledShaderSource and the legacy re-export are dead scaffolding — never invoked anywhere (renderer.ts imports only the prefix/rewrite/emit helpers and composes stages itself), and the 'For now… will be activated stage-by-stage' comments are stale since docs declare the stage path live.
  - _Fix:_ Delete the uncalled composer half (compileShaderSource, buildComposedFragment, getActiveStages, compilerSignature, CompiledShaderSource, emitIsvDecl/defaultForType, stageOrder/phaseIndex if then unused) plus the `export { legacyBuildFragmentShader, VERTEX_SHADER }` re-export and the now-unused useRegistry/shaders imports, keeping the shared helpers renderer.ts uses; alternatively, if the composer is imminent orchestrator-rewrite work, wire renderer.ts to it or mark it clearly as pending with the stale 'legacy path' comments corrected to match docs.

### `src/state/catalog-store.ts`

- **L291 [DUP]** removePhoto's single-photo path duplicates removePhotos (emitPhotoRemove, deletePhoto, state prune, broadcast) with one divergence: the single path broadcasts { action: "remove", id } while the batch path omits id, so other windows get less information depending on which path ran.
  - _Fix:_ Make removePhoto delegate unconditionally to removePhotos(withVirtualCopies(...)), and have removePhotos include id when exactly one photo is removed (matching commit()'s ids.length === 1 convention).

### `src/state/develop-adjustments.ts`

- **L89 [SLOP]** setAdjustment funnels through double `as any` (with an eslint-disable) at the typed setParam boundary even though parent is statically "vignette" | "grain", which a small typed switch or generic helper would express without erasing types.
  - _Fix:_ Branch on a.parent: if (a.parent === "vignette") st.setParam("vignette", { ...st.params.vignette, [a.field]: value }); else st.setParam("grain", { ...st.params.grain, [a.field]: value }); — keeps the union narrowed and drops both casts and the unsafe Record<string, Record<string, number>> read as well.

### `src/state/develop-store.ts`

- **L136 [HARDCODED]** The neutral-WB fallback 6500 is written literally in three places in this file (initial state, loadEdit's `asShotTemperature ?? 6500`) plus independently in catalog/types.ts (temperature: 6500 // Kelvin; 6500 = neutral), so the copies can drift — and this exact fallback already caused the batch loadEdit warm-thumbnail bug.
  - _Fix:_ Export a NEUTRAL_TEMPERATURE_K constant from @/catalog/types (next to DEFAULT_DEVELOP_PARAMS, whose temperature should reference it) and use it in develop-store's initial state and loadEdit fallback.
- **L205 [DUP]** The 4-line edit-update broadcast block is copy-pasted eight times across setParam, setDynParam, setDynParams, setToneCurve, setHslValue, applyPreset, resetParams and reset, while the mask slice already factored the identical pattern into its pushEdit helper.
  - _Fix:_ Extract one module-level pushEdit(get) helper (or reuse/lift the mask-slice one into a shared util) and call it from all eight setters.

### `src/state/headless-frame.ts`

- **L24 [DUP]** headless-frame.ts duplicates edited-thumbnail.ts almost verbatim: the THUMB_SOURCE_MAX_EDGE = 1280 constant (with the same comment) plus the ~40-line three-tier render flow (resident-source render → decode/uploadSource/retry → camera-JPEG fallback) and an identical private renderFromSource helper, so the copies can drift (they already diverge on quality 0.9 vs 0.8).
  - _Fix:_ Extract a shared helper (e.g. renderPhotoBlobViaThumbRenderer(photo, params, { maxEdge, quality, paramBag })) that owns THUMB_SOURCE_MAX_EDGE and the three-tier fallback; both callers pass their own maxEdge/quality.

### `src/ui/components/CurveEditor.tsx`

- **L154 [DUP]** handlePointerMove and moveSelected contain near-identical endpoint/neighbor-clamp logic (x pinned to 0/1 at ends, lo/hi = neighbor ± 0.001 in between), and setInputPct repeats the lo/hi clamp a third time; a change to the clamp epsilon must be made in three places.
  - _Fix:_ Extract a `clampPointX(points, i, x)` helper (endpoint pin + neighbor epsilon clamp) and use it in handlePointerMove, moveSelected, and setInputPct.

### `src/ui/components/Histogram.tsx`

- **L31 [HARDCODED]** The valid histogram-mode list is defined twice — the MODES array and the VALID_MODES set — and the copies can drift if a mode is added.
  - _Fix:_ Derive it: `const VALID_MODES = new Set<string>(MODES.map((m) => m.key));` (move below the MODES declaration).
- **L385 [HARDCODED]** The channel colors (#e74c3c / #2ecc71 / #4aa3ff and their rgba fills) are duplicated across Histogram's MODES, drawHistogram's fillCurve calls, and CurveEditor's CHANNELS, so a palette tweak can leave the curve editor and histogram out of sync.
  - _Fix:_ Define the R/G/B channel colors once (a small shared constant module or CSS variables) and derive both the MODES/CHANNELS entries and the rgba fills from it.

### `src/ui/components/LayoutMenu.tsx`

- **L104 [DUP]** MenuItem plus the outside-click-close effect and the trigger-button styling are duplicated nearly verbatim between LayoutMenu.tsx and ViewMenu.tsx (only divergence: LayoutMenu's MenuItem adds a title prop), so styling/behavior fixes must be made twice.
  - _Fix:_ Extract a shared top-bar dropdown primitive (trigger button + outside-click close + MenuItem/MenuLabel with optional title) and use it from both LayoutMenu and ViewMenu.

### `src/ui/components/ModalWindow.tsx`

- **L87 [SLOP]** Dead condition in the focus-trap filter: querySelectorAll never returns the root element, so `el === box` can never be true; additionally the offsetParent test wrongly excludes visible position:fixed descendants from the trap.
  - _Fix:_ Drop the `|| el === box` clause; if fixed-position children should be tabbable, use a visibility check (el.getClientRects().length > 0) instead of offsetParent.

### `src/ui/components/PreferencesDialog.tsx`

- **L688 [DUP]** Because SliderField has no hint prop, the 'Background dimming' field hand-rolls a wrapper div with its own useFieldVisible call and a copy of the standard hint-paragraph markup used by Field/ToggleField.
  - _Fix:_ Add an optional `hint?: string` prop to SliderField (render the shared hint paragraph and pass it to useFieldVisible like Field/ToggleField do), then collapse the Background dimming block to a single SliderField call.
- **L981 [DUP]** CanvasSurroundField hand-copies ToggleField's entire switch markup (role="switch" button, track and knob spans with identical class strings) instead of sharing a primitive.
  - _Fix:_ Extract the switch row (label + track/knob spans) into a small SwitchRow component used by both ToggleField and CanvasSurroundField (ToggleField becomes SwitchRow + hint paragraph; CanvasSurroundField becomes SwitchRow + hint + swatch strip).

### `src/ui/components/TopBar.tsx`

- **L96 [DUP]** The Preferences button exists twice: a module-level `prefsButton` element used only in the detached branch, and an identical inline copy in the main branch (line 220) that can drift.
  - _Fix:_ Use the single `prefsButton` element (or a small component) in both branches and delete the inline duplicate at line 220.

### `src/ui/spring-animation.ts`

- **L10 [SLOP]** Entire module is dead code: createSpring/estimateVelocity are exported but imported nowhere in src/, and momentum panning was explicitly rejected as a feature (viewport pan stops on release).
  - _Fix:_ Delete src/ui/spring-animation.ts.

### `src/update/update-checker.ts`

- **L204 [SLOP]** checkForUpdate and checkForUpdateNow both take a dead `_ignored: string` first parameter, and callers still ritually pass __APP_VERSION__ into it (UpdateBanner.tsx:34), a leftover from before resolveCurrentVersion() was introduced.
  - _Fix:_ Drop the `_ignored` parameter from both functions and update the call sites (UpdateBanner.tsx and any manual-check UI) to pass only the channel.

