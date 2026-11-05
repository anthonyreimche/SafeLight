# Images for the developer docs

Plain app screenshots only: real Safelight windows, the stock Safelight Neutral theme, no mock-ups or generated art. Diagrams are Mermaid blocks in the pages themselves, so they stay editable as text. Photos go in as JPEG, UI-only shots as PNG.

| File | Shows | Used in |
|---|---|---|
| `dev-folder.png` | Extensions ▸ Dev with the tutorial extension loaded: path, Change, Rescan, Clear, the row's status and Reload | first-extension.md |
| `faded-film-panel.jpg` | The tutorial's Faded Film panel over a photo, Strong preset applied | first-extension.md |
| `pipeline-tab.png` | Developer Tools ▸ Pipeline with the tutorial stage in `display-adjust` | debugging.md |
| `stage-error.png` | The Console after a GLSL typo in the tutorial stage | debugging.md |
| `grid-menu-item.jpg` | Library right-click menu, extension items in the last group | recipes.md |
| `store-page.png` | A store detail page (Batch Tools) | publishing.md |

All were taken from Safelight 3.2.0 on 2026-11-03, with the tutorial's two files loaded through the dev folder exactly as the page gives them.

Still to record:

| File | Shows | Would go in |
|---|---|---|
| `reload-loop.gif` | Edit `index.js` → save → ↻ Reload → the photo changes (under 10 s) | first-extension.md §4 |
| `install-devtools.gif` | Browse → Developer Tools → Install → the Dev section appears | debugging.md |
| `export-processor.png` | The Export panel with an extension's processor section open (needs one installed, such as the copyright stamp recipe) | recipes.md |
