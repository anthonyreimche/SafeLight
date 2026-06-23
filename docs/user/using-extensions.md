# Using Extensions

Safelight is extensible: panels, tools, themes, display transforms, and more are installed from GitHub, and every stock panel can be disabled and replaced by a community version. This page covers finding, installing, and managing extensions. To *build* one, see the [developer guide](../dev/extensions/README.md).

## The Extensions panel

The Extensions panel (**View ▸ Extensions**, or **Ctrl+Shift+X**) is a GitHub-backed app store with master/detail browsing, READMEs, categories, and update checks. It covers the full lifecycle:

- **Install** — browse official extensions (GitHub repos tagged with the `safelight-extension` topic; configurable in Preferences ▸ Extensions) or enter `owner/repo`, `owner/repo#branch`, or a github.com URL. The repo is downloaded into `<userData>/plugins/<id>/` and activated live — no restart.
- **Disable / enable** — the toggle on each row deactivates an extension and removes its contributions while keeping its files and settings. Re-enabling is instant.
- **Settings** — extensions that expose options get a section in **Preferences ▸ Extensions**.
- **Update** — the store checks each installed extension's latest GitHub release. The **Updates** tab (first in the sidebar, with a badge showing the count) lists every installed extension that has a newer release; its Update button downloads the new release and reinstalls the extension in place — no restart, and your settings are kept. Updates can also be applied from an extension's detail page or, opt-in, automatically (Preferences ▸ Extensions). An update that needs a newer Safelight than you have is refused until you update Safelight itself.
- **Uninstall** — removes the extension *and deletes its files and stored settings*.

Built-in panels appear under **Built-in**; they can be disabled but not uninstalled. **Safelight Core** (the extension manager, stock themes, the Classic layout, and the built-in display transform) is locked and always on.

## Are extensions safe?

Extensions are JavaScript running inside the app, installed from GitHub repos you choose. Install only extensions you trust — the same judgment you'd apply to IDE plugins.

## Bundled examples

Safelight ships three example extensions (in the repo's `extensions/` folder) that double as working references:

- **Advanced Library Sort** — custom sort orders, a live search bar, and smart searches.
- **Image Comparison** — before/after via hold-to-preview and a draggable split on the Develop canvas.
- **XMP Tools** — XMP sidecar read/write and Lightroom preset import.

## Manual install

Extension installation downloads from GitHub. On a restricted network, you can install manually instead: clone the repo to a local folder, then drag-and-drop the folder onto the Extensions panel. If an install fails with "Failed to fetch", check your connection and whether `raw.githubusercontent.com` is allowed through your firewall.
