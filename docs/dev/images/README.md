# Images for the developer docs

Plain app screenshots and short screen recordings only: real Safelight windows at 100% UI scale, the stock Safelight Neutral theme, no mock-ups or generated art. Diagrams are Mermaid blocks in the pages themselves, so they stay editable as text.

Each page marks where its image goes with an HTML comment naming the shot. Replace the comment with the image once it's recorded.

| File | Kind | Shows | Used in |
|---|---|---|---|
| `dev-folder.png` | Screenshot | Extensions window, Dev section, with **Choose folder…**, **↻ Rescan** and one extension's **↻ Reload** circled | first-extension.md §1, debugging.md |
| `reload-loop.gif` | GIF, under 10 s | Edit `index.js` in a text editor → save → **↻ Reload** → drag a slider and the photo changes | first-extension.md §4 |
| `faded-film-panel.png` | Screenshot | The finished Faded Film panel docked in Develop, beside a photo with the effect applied | first-extension.md §4 |
| `install-devtools.gif` | GIF | Extensions window → Browse → Developer Tools → Install → the Dev section appears | debugging.md |
| `pipeline-tab.png` | Screenshot | Developer Tools ▸ Pipeline with a third-party stage listed in its phase | debugging.md, rendering.md |
| `stage-error.png` | Screenshot | An extension row showing `Stage "…" failed to compile and is off` | debugging.md |
| `export-processor.png` | Screenshot | Export panel with an extension's section (the copyright stamp recipe) expanded | recipes.md |
| `grid-menu-item.png` | Screenshot | Library right-click menu with an extension's item | recipes.md |
| `store-page.png` | Screenshot, annotated | A store detail page with the icon, README, screenshots, version list and "What's new" labelled by the manifest field or GitHub setting each comes from | publishing.md |
