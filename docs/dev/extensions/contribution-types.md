# Contribution Types

← [Building Extensions](README.md)

Every `register*` call, one line each, with a link to its full reference. Everything you register is removed for you when the extension stops. [How Safelight works](../concepts.md#where-to-find-everything) maps goals to these calls and to real extensions that use them.

## UI

| Call | Adds |
|---|---|
| [`registerModule`](../api/ui-shell.md#modules) | A top-level module beside Library and Develop, with its own tab and dock layout |
| [`registerPanel`](../api/ui-shell.md#panels-registerpanel) | A dockable React panel. Add `mask` to offer it [inside masks](../api/ui-shell.md#per-mask-panels-panelcontributionmask). |
| [`registerPanelHeaderAccessory`](../api/ui-shell.md#panel-header-accessories-registerpanelheaderaccessory) | One control on every panel's header |
| [`registerSlot`](../api/ui-shell.md#slots-registerslot) / `unregisterSlot` | A component in a named region of core chrome (toolbars, canvas overlay, Detail panel) |
| [`registerLayout`](../api/ui-shell.md#layouts-registerlayout) | A named dock arrangement for the Layout menu |
| [`registerTheme`](../api/contributions.md#themecontribution) | A named set of CSS custom properties |
| [`registerStylesheet`](../api/contributions.md#stylesheetcontribution) / `unregisterStylesheet` | CSS applied after core styles, through the [styling hooks](../api/components.md#styling-hooks) |
| [`registerCursor`](../api/contributions.md#cursorcontribution) | A named canvas cursor, set with `api.develop.setCanvasCursor` |
| [`registerSliderIcon`](../api/contributions.md#slidericoncontribution) | An inline SVG beside a slider label |

## Imaging

| Call | Adds |
|---|---|
| [`registerProcessingStage`](../api/contributions.md#processingstagecontribution--gpu-stage) / `unregisterProcessingStage` | GLSL compiled into the develop program, in a phase you choose. See [How a photo is rendered](../rendering.md). |
| [`setStageTexture`](../api/contributions.md#processingstagecontribution--gpu-stage) | Pixel data (a LUT, a table) for a texture a stage declares |
| [`registerPipeline`](../api/contributions.md#pipelinecontribution--display-transform) | A display transform (tone mapper), picked per photo in Develop's bottom bar |

## Catalogue and Library

| Call | Adds |
|---|---|
| [`registerCatalogHooks`](../api/contributions.md#cataloghookscontribution) | Callbacks on photo import, metadata change, edit commit and removal |
| [`registerGridFilter`](../api/contributions.md#gridfiltercontribution) | A predicate that narrows the Library grid |
| [`registerLibrarySort`](../api/contributions.md#librarysortcontribution) | A sort order in the Library toolbar |
| [`registerGridMenuItem`](../api/contributions.md#gridmenuitemcontribution) | An action in the Library right-click menu |
| [`registerPresetImporter`](../api/contributions.md#presetimportercontribution) | A reader for other apps' preset files in the Presets panel |

## Export

| Call | Adds |
|---|---|
| [`registerExportProcessor`](../api/contributions.md#exportprocessorcontribution) | A step on the export's pixels (needs Safelight 3.1.0), on the encoded file, or both, with Export-panel settings |
| [`registerFilenameTemplate`](../api/contributions.md#filenametemplatecontribution) | A named `{variable}` template for output file names |

## Input and settings

| Call | Adds |
|---|---|
| [`registerKeybinding`](../api/contributions.md#keyactioncontribution) | An action the user can rebind in Preferences ▸ Shortcuts |
| [`registerSettings`](../api/contributions.md#settingscontribution) | A settings section: declared fields or your own component |

Beyond `register*`, the API can render photos headlessly, add records, copy edit stacks and share values between extensions. See [State Stores & Data APIs](../api/stores.md).

## Examples

[Recipes](recipes.md) has complete versions of the common cases: a Library menu item, a copyright stamp on export, a sidecar file per photo, a 3D LUT and a theme. [Your first extension](first-extension.md) covers a panel with sliders driving a GPU stage.
