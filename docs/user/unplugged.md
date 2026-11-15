# Safelight Unplugged

Safelight Unplugged, `slu` for short, is Safelight without the window. You type a command and some values, and your photos change: `slu set IMG_4021.ARW exposure=+0.7`. It is for batches, for scripts, for a machine with no screen worth looking at, and for anyone who would rather type than drag a slider.

It is the same Safelight underneath. It reads and writes the same catalogue, so an edit made with `slu` is a step in the photo's history that you can undo in the app, and the other way round. Exports render through the app's own engine, so a file from `slu export` matches a file from the Export panel.

There is no terminal screen to learn and no question it asks, except one: whether to trust an extension you are installing. You name what you want, `slu` does it and says what it did.

## Running it today

For now `slu` runs from a copy of the Safelight repository. Packaged launchers come later.

1. Build the app and the command line once: `npm run build:app`, then `npm run build:cli`.
2. Run the launcher: `scripts\slu.cmd` on Windows, `scripts/slu.sh` on macOS and Linux.

```
scripts\slu.cmd help
scripts/slu.sh version
```

Everything below writes `slu` for the launcher.

## Choosing photos

Most commands take photos first, then what to do to them.

| You type | It means |
|---|---|
| `IMG_4021.ARW` | That file. |
| `*.ARW`, `2026-11/**/*.RAF` | A pattern. `slu` expands it itself, so it works the same in cmd, PowerShell and a Unix shell. It ignores case on Windows and macOS. `*` and `?` stay inside a folder, `**` crosses folders, and `{a,b}` picks one word. `[abc]` is not a pattern: brackets, and braces with no comma, match themselves. |
| `shoot/` or `.` | Every photo directly in that folder. Add `-r` to go into subfolders. |
| `--all` | Every photo in the project. |
| `--project <folder>` | Use that project instead of the one the photos sit in. |
| `--rating 3+`, `--rating 2-4` | Only photos with that rating. |
| `--flag pick`, `--label red` | Only photos with that flag or label. `none` matches the ones without. |
| `--edited`, `--unedited` | Only photos that have, or haven't, been edited. |
| `-` | Read photo paths from standard input, one per line. |
| `--` | Everything after it is a photo, even a name with an `=` in it. |

Filters narrow whichever of the others you gave. `slu photos . --flag pick --rating 4+` lists the picks with four stars or more.

`slu` finds the project the way the app does: it walks up from the photo to the nearest folder holding `.safelight/catalog.json`. A photo that isn't in a project is refused (exit code 2), because there is no catalogue to change. Open its folder in Safelight once and it has one.

## Values

A value is a key and what to do to it, with no spaces: `exposure=+0.7`.

| Form | Meaning |
|---|---|
| `exposure=0.5` | Set to 0.5. `=` is always absolute, and `exposure=+0.5` is the same thing. |
| `exposure+=0.3`, `contrast-=10` | Change by that much. |
| `exposure=default` | Back to the default. For `temperature` the default is the photo's as-shot white balance. |
| `temperature=5600K`, `exposure=+0.7EV`, `straighten=-1.2°` | A unit may follow the number if it is the value's own unit (`K`, `EV`, `°`). A wrong unit is an error. Plain numbers always work. |
| `transform.flipH=on` | Switches take `on`/`off`, `true`/`false` or `1`/`0`. |
| `uprightMode=auto` | Choices take their name. |

Keys are the names the edit stores, so `slu get IMG_4021.ARW --json` gives back what `slu set` takes. Capitals don't matter, and `colour` matches `color` (`colourNR` finds `colorNR`). A misspelt key gets a "Did you mean" suggestion.

A value past its range is set to the limit, with one warning, and the command still succeeds. Add `--strict` to make it an error.

Values on a range that goes below zero always print with a sign: `+0.25`, `-40`.

### What you can set

| Tool | Keys |
|---|---|
| White Balance | `temperature` (2000 to 50000 K), `tint` (-150 to 150) |
| Basic | `exposure` (-5 to 5 EV); `contrast`, `highlights`, `shadows`, `whites`, `blacks`, `texture`, `clarity`, `dehaze`, `vibrance`, `saturation`, `highlightDetail`, `shadowDetail` (-100 to 100) |
| Detail | `sharpening` (0 to 150), `sharpenRadius` (1 to 3), `sharpenDetail`, `sharpenMasking`; noise reduction `luminanceNR`, `luminanceNRDetail`, `luminanceNRContrast`, `luminanceNRShadows`, `luminanceNRHighlights`, `colorNR`, `colorNRDetail`, `colorNRSmoothness` (0 to 100) |
| Effects | `vignette.amount`, `vignette.roundness` (-100 to 100); `vignette.midpoint`, `vignette.feather`, `vignette.highlights` (0 to 100); `grain.amount`, `grain.roughness`, `grain.color` (0 to 100); `grain.size` (25 to 100) |
| HSL | `hsl.hue.red`, `hsl.saturation.blue`, `hsl.luminance.green` and so on: three bands (`hue`, `saturation`, `luminance`) for each of `red`, `orange`, `yellow`, `green`, `aqua`, `blue`, `purple`, `magenta` (-100 to 100) |
| Colour Grading | `colorGrading.<shadows, midtones, highlights or global>.hue` (0 to 360°), `.sat` (0 to 100), `.luma` (-100 to 100); `colorGrading.shadowRange`, `colorGrading.highlightRange` (0 to 100) |
| Transform | `transform.perspectiveV`, `perspectiveH`, `aspect`, `offsetX`, `offsetY` (-100 to 100); `transform.scale` (50 to 150); `transform.flipH`, `transform.flipV` (on/off); `uprightMode` (`off`, `level`, `vertical`, `auto`, `full`) |
| Crop and Straighten | `straighten` (-45 to 45°) |
| Tone mapper | `displayTransform`: a tone mapper's id, or `default` to follow Preferences |

`slu tools <photo>` lists the values a photo has with their ranges, and `slu tools --all` includes idle tools.

Some things are shown but can't be set from `slu`: the tone curve's points, masks, Heal spots, crop rectangles, guided Upright lines and paint layers. `slu get` shows them, and `slu set` says to edit them in Safelight.

Extension values are listed with their ranges (when the extension has been run in Safelight at least once) and can be reset or removed, but not set yet. `slu set` answers "Local Contrast doesn't support slu yet. Set it in Safelight." (or whichever tool it is).

## Commands

`slu help` lists them in the groups below, and `slu help <verb>` (or `slu <verb> --help`) shows one command's usage and examples.

### Look

| Command | What it does |
|---|---|
| `slu photos [photos] [filters]` | Lists photos: name, rating, flag, label, edited or not. |
| `slu tools [photo] [--all]` | The tools in pipeline order. With a photo: each value with its range and unit, and a ✱ by values away from their default. |
| `slu get <photo> [key…]` | The photo's values, all of them or the ones named. `--json` gives the current step as stored. |
| `slu history <photo>` | The numbered steps with labels and times, the current one marked. |
| `slu preview <photo> [--width cols] [--try key=value…] [--graphics mode]` | Prints the edited photo in the terminal. `--graphics` is `kitty`, `iterm`, `blocks` or `none`. `--try` renders with those values without storing them, and is required when you give `key=value`. |

### Edit

| Command | What it does |
|---|---|
| `slu set <photos> key=value…` | Sets values. One history step per photo, labelled with the values' names, as a slider move is. |
| `slu add <photos> <tool>` | For a core tool, lists its keys; there is nothing to turn on. Extension tools can't be added from `slu` yet. |
| `slu remove <photos> <tool>` | Puts all the tool's values back to their defaults in one step. Works on extension tools too. |
| `slu reset <photos> [key…]` | Resets the keys named, or with none everything `slu` can set, in one step. With no keys it leaves the tone curve, masks, retouch spots, crop and guide lines alone, because `slu` can't show or edit them, and says which of those it kept. |
| `slu undo <photos> [n]`, `slu redo <photos> [n]` | Moves back or forward `n` steps (default 1), as Undo and Redo do. |

### Share

| Command | What it does |
|---|---|
| `slu copy <photo> [--tools a,b]` | Remembers a photo's settings. It leaves out the per-photo tools Paste Settings leaves out. |
| `slu paste <photos> [--tools a,b] [--from <photo>]` | Applies the copied settings, one step per photo. `--from` copies and pastes in one go. |
| `slu presets` | Lists the presets Safelight has saved, by group. |
| `slu apply <preset> <photos>` | Applies a preset over the current values, one step per photo. |

`set`, `add`, `remove`, `apply` and `paste` take `--preview` to print the result in the terminal when exactly one photo changed.

### Organize

| Command | What it does |
|---|---|
| `slu rate <photos> <0-5>` | Star rating. |
| `slu flag <photos> pick\|reject\|none` | Flag. |
| `slu label <photos> red\|yellow\|green\|blue\|purple\|none` | Colour label. |

Like in the app, these change the photo's record and add no history step.

### Output

| Command | What it does |
|---|---|
| `slu export <photos> [-o dir\|file\|-] [options]` | Renders photos. The defaults are Preferences ▸ Export. |

Export options: `--format jpg\|png\|tiff\|webp`, `--quality 1-100` (JPEG and WebP), `--long-edge <px>` or `--size original`, `--colour-space srgb\|display-p3\|adobe-rgb\|prophoto-rgb`, `--bit-depth 8\|16` (PNG and TIFF), `--name <template id>` (a filename template an extension registered), `--existing number\|replace`, and `--try key=value…` (a `key=value` without `--try` is refused, since export stores nothing). A photo it can't find is reported and the rest are still exported, ending in exit code 6. `-o -` writes one image to standard output. Export writes image files, not the catalogue, so it works while Safelight has the project open.

### Extensions

| Command | What it does |
|---|---|
| `slu search <words…>` | Searches the extension registry. |
| `slu install <name>… [--version X] [--yes]` | Installs from the extension's release. For an extension that isn't verified, `slu` shows what it may reach and asks. When nothing can answer (a script), it refuses unless you add `--yes`. A banned extension is refused. |
| `slu uninstall <name>…` | Removes it. Photos keep its values. |
| `slu update [name…]` | Updates the named extensions, or all with a newer release, from the repository `slu` or Safelight installed each one from. An extension that isn't verified and asks for new permissions is asked about again, and refused when nothing can answer unless you add `--yes`. When `slu` and Safelight installed one id from two different repositories, `slu` can't tell which is current and leaves it alone: update it in Safelight. |
| `slu extensions` | Installed extensions: name, id, version, on or off, trust, update available. |
| `slu enable <name>…`, `slu disable <name>…` | The same on/off switch as Safelight's. Until Safelight has been opened once, `slu` can't see which extensions are on, so these refuse (exit code 5). |

A name can be an id (`local-contrast`, `safelight.basic`), the id without `safelight.`, the repository name, `owner/repo`, or the display name with dashes (`contrast-and-texture`). `slu install essentials` installs a kit. A name that matches several extensions lists them and installs none. Installs, updates and removals take effect the next time Safelight starts.

### More

| Command | What it does |
|---|---|
| `slu doctor` | The version, the app `slu` runs with, the graphics backend, terminal image mode, the project lock for the current folder and extensions that failed to load. |
| `slu version` | The version and process version. Same as `--version`. |
| `slu help [verb]` | Help. Same as `-h` and `--help`. |

### Options every command takes

`--json`, `-q`, `-v` (`-vv` adds the engine's log; short flags can be joined, as in `-qv`), `--yes` (`-y`), `--strict`, `--wait[=seconds]`, `-h`, `--version`.

## Pipes and batches

Pass all your photos to one command. A command that draws pictures (`export`, `preview` and `--preview`) starts an invisible copy of Safelight's engine, which takes a few seconds to start, so one command over a hundred photos is much faster than a hundred commands over one. Only one `slu` engine runs at a time.

```
slu set . --flag pick temperature=5400K exposure+=0.3 vibrance=15
slu export . --rating 4+ -o ../web --long-edge 2048 --quality 82 -q
slu photos . --rating 4+ --json | jq -r '.photos[].path' | slu apply "Warm film" -
```

## Output and exit codes

Results go to standard output, in aligned columns with colour when it is a terminal and `NO_COLOR` isn't set. Warnings and progress go to standard error. `-q` prints errors only, and `-v` says what `slu` did.

With `--json` a command prints one document, `{"slu": 1, …}`. A command over several photos gives a `photos` array with an entry for each, carrying `ok` or `error`. Keys are the stored keys and values are plain numbers, booleans and strings.

| Code | Meaning |
|---|---|
| 0 | Done. Clamping warnings don't change this. |
| 1 | Usage: an unknown command, key or option, or a value that doesn't fit. |
| 2 | A photo problem: not found, can't be decoded, or not in a project `slu` can write to. |
| 3 | An engine problem: no graphics path, or the engine didn't start. |
| 4 | Busy: Safelight has the project open. |
| 5 | An extension problem: name not found or ambiguous, refused, or the network. |
| 6 | Partly done: some photos in a batch failed. The output says which. |
| 130 | Stopped with Ctrl+C. Steps already written stay written. |

## When Safelight has the folder open

Safelight and `slu` are separate programs, and two programs saving the same catalogue would lose changes. So only one writes at a time, and a `writer.lock` file in the project's `.safelight` folder says who.

- Commands that only read work anyway: `photos`, `tools`, `get`, `history`, `preview`, `presets`, `export` and `doctor` show what Safelight last saved.
- Commands that change the catalogue are refused with nothing changed, exit code 4: `set`, `add`, `remove`, `reset`, `undo`, `redo`, `paste`, `apply`, `rate`, `flag` and `label`. Close the folder in Safelight, or add `--wait` to wait for it to let go (`--wait=60` gives up after a minute).
- While `slu` is writing, Safelight opening the same folder waits a moment.
- Extension commands don't touch projects, so they aren't locked.

A lock left by a program that has closed or crashed on this computer counts as left over and is taken over at once. One held from another computer, for a project on a shared drive, is taken over once it hasn't been refreshed for 15 minutes.

## Preview limits

`preview` and `--preview` draw into the terminal's text, so they show a photo's look, not its pixels.

- A terminal that speaks the kitty or iTerm2 image protocols shows the real picture. Others get coloured blocks, which are coarse. `--graphics` chooses.
- On Windows `slu` recognises Windows Terminal and shows blocks. The line under the picture says the mode and warns when the colour isn't true colour.
- It is a small picture, scaled to fit. Judge detail and colour in Safelight or in an exported file.

## What's not in this release

- `auto` (Auto Tone and Auto White Balance) and `save-preset` are not built yet. `save-preset` says to save presets in Safelight.
- Setting an extension's values, and `add` for an extension tool. They can be listed, reset and removed.
- The tone curve's points, masks, Heal, crop ratios, guided Upright, paint layers and keywords.
- Photos that aren't in a catalogue: `slu` doesn't import them or start a catalogue.
- Sixel images, and running several commands against one warm engine.
- Attaching to a running Safelight, so changes appear live.
- Packaged launchers, a `slu` on your PATH from the installer, and shell completion.
- Extensions' own commit hooks. They are skipped, with a warning; `slu doctor` lists the extensions that have them.
