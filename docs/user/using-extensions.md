# Using Extensions

Safelight is extensible: panels, tools, themes, display transforms, and more are installed from GitHub, and every stock panel can be disabled and replaced by a community version. This page covers finding, installing, and managing extensions. To *build* one, see the [developer guide](../dev/extensions/README.md).

## The Extensions panel

The Extensions panel (**View ▸ Extensions**, or **Ctrl+Shift+X**) is a GitHub-backed app store with master/detail browsing, READMEs, categories, and update checks. It covers the full lifecycle:

- **Install** — browse official extensions (GitHub repos tagged with the `safelight-extension` topic; configurable in Preferences ▸ Extensions) or enter `owner/repo`, `owner/repo#branch`, or a github.com URL. The repo is downloaded into `<userData>/plugins/<id>/` and activated live — no restart.
- **Disable / enable** — the toggle on each row deactivates an extension and removes its contributions while keeping its files and settings. Re-enabling is instant.
- **Settings** — extensions that expose options get a section in **Preferences ▸ Extensions**.
- **Update** — the store checks each installed extension's latest GitHub release (or, for an extension that publishes from its main branch, the version on that branch). The **Updates** tab (first in the sidebar, with a badge showing the count) lists every installed extension that has a newer version. Open **What's new** on a row to read the release notes; its Update button downloads the new version and reinstalls the extension in place — no restart, and your settings are kept. Updates can also be applied from an extension's detail page or, opt-in, automatically (Preferences ▸ Extensions). An update that needs a newer Safelight than you have is refused until you update Safelight itself.
- **Choose a version** — an extension that publishes releases has a version list on its detail page, with its release notes under **What's new**. Pick an older release to go back to it: Safelight keeps you on that version (the page says **Kept at**), so auto-update leaves it alone and the Updates badge doesn't count it, though the Updates tab still shows the newer one. To follow new releases again, pick **Latest** and click **Update** (or **Switch**, if you're on a pre-release). Pre-releases are in the list too; once you install one, you're offered newer pre-releases until a full release passes them.
- **Uninstall** — removes the extension *and deletes its files and stored settings*.

Built-in panels appear under **Built-in**; they can be disabled but not uninstalled. **Safelight Core** (the extension manager, stock themes, the Classic layout, and the built-in display transform) is locked and always on.

## Are extensions safe?

Extensions are JavaScript running inside the app, installed from GitHub repos you choose. Install only extensions you trust — the same judgment you'd apply to IDE plugins.

## Where to start

Safelight installs nothing without asking: you pick extensions here or in the welcome setup's starter kits. A few to try first:

- **Advanced Library Sort** — custom sort orders, a live search bar, and smart searches.
- **Image Comparison** — before/after via hold-to-preview and a draggable split on the Develop canvas.
- **XMP Tools** — XMP sidecar read/write and Lightroom preset import. Lightroom `.xmp` presets need an importer like this one; without one, the Presets panel's Import says so and links to the store's **Presets** category.

## Starter kits

Starter kits are groups of verified extensions by shooting style, curated in the Safelight extension registry. Open **Starter kits** in the Extensions store (or run the welcome setup again) to install a kit. Kits only list extensions on the verified list, and setup only installs the version that was reviewed: if an extension has moved past its review, or Safelight can't confirm its current version right now, setup skips it and you can install it from the store yourself. Setup never removes anything; uninstall extensions from the store's **Installed** tab.

## Manual install

Extension installation downloads from GitHub. On a restricted network, you can install manually instead: clone the repo to a local folder, then drag-and-drop the folder onto the Extensions panel. If an install fails with "Failed to fetch", check your connection and whether `github.com`, `api.github.com`, `codeload.github.com` and `*.githubusercontent.com` are allowed through your firewall.
