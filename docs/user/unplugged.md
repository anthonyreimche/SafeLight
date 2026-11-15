# Safelight Unplugged

Safelight Unplugged is Safelight without the window, and its command is `safelight`. You type a command and some values, and your photos change: `safelight set IMG_4021.ARW exposure=+0.7`. It is for batches, for scripts, for a machine with no screen worth looking at, and for anyone who would rather type than drag a slider.

It is the same Safelight underneath. It reads and writes the same catalogue, so an edit made with `safelight` is a step in the photo's history that you can undo in the app, and the other way round. Exports render through the app's own engine, so a file from `safelight export` matches a file from the Export panel.

It also does the library work, so you never need the window to get started: `safelight ls` shows what is in a folder, `safelight import` brings it into a catalogue, and `safelight open` lets you step through photos at the prompt. You name what you want, `safelight` does it and says what it did. One-shot commands ask nothing, except whether to trust an extension you are installing.

## The home screen and prompt

Type `safelight` on its own and it opens a home screen: the bulb, the version, the project in this folder with its photo and edit counts, the graphics backend, your extensions, and a few commands to try. Below it is a prompt where you type the same commands without `safelight` in front:

```
Iceland 2026 › tools DSC_0412.NEF
Iceland 2026 › set DSC_0412.NEF exposure=+0.5 shadows+=20
Iceland 2026 › export DSC_0412.NEF -o out
```

- **Tab** completes commands, options, file names, value names after a photo, and installed extension names.
- **Up and Down** go through what you typed before, kept between sessions.
- **`cd <folder>`** moves to another folder, and the prompt shows its project and the folder you are in. **`home`** shows the home screen again. **`clear`** clears the screen. **`next`**, **`prev`** and **`close`** work on the photos you have opened (see below).
- **Ctrl+C** stops the command that is running and keeps you at the prompt. At an empty prompt, press it twice, type `exit`, or press Ctrl+D to leave.
- Pasting several lines runs them one after another.

The prompt keeps one engine running once you export or preview, so only the first one waits for it to start. It closes after 10 idle minutes or when you leave. Nothing else is held between commands, so the app can open the project while the prompt sits there.

### Opening photos

`open` makes photos the working set, the way Develop holds the photo you are editing. The prompt shows which one is current, and a command that names no photo acts on that one:

```
Iceland 2026 › open *.NEF
Iceland 2026 › DSC_0412 1/3 › set exposure=+0.5
Iceland 2026 › DSC_0412 1/3 › next
Iceland 2026 › DSC_0413 2/3 › set @all contrast+=5
Iceland 2026 › DSC_0413 2/3 › close
```

- `open` takes photos, patterns, folders and filters, like every command. With no argument it lists the set.
- `next [n]` and `prev [n]` move through the set and show the new photo. PageDown and PageUp on an empty line do the same. `close` empties the set.
- `@` names the current photo and `@all` the whole set. A command with no photo acts on the current photo only, so a batch always says `@all` or names its photos. Before you press Enter the footer shows which photo a command will touch.
- Each time the current photo changes, the prompt shows it with its changed values beside the picture, and an edit shows its result the same way. `--no-preview` skips the picture.
- `cd` to another project closes the set. A photo removed meanwhile drops out of it, with a line saying so.
- Nothing is held open: there is no lock between commands, so Safelight can open the project while a set is open. Commands that change something are then refused one at a time, as described below.
- `safelight open <photos>` from a shell starts the prompt with those photos open. It needs a terminal, so in a script it is a usage error (exit code 1); use `tools`, `preview` or `export` there. `next`, `prev` and `close` only exist at the prompt.

When the output goes to a file or another program, `safelight` on its own prints the help instead.

## Running it today

For now `safelight` runs from a copy of the Safelight repository. Packaged launchers come later. On Linux the packaged app's binary is also called `safelight`; the command-line edition is still run from the repo today.

1. Build the app and the command line once: `npm run build:app`, then `npm run build:cli`. On Windows, `build-scripts\build-safelight-unplugged.bat` does both and checks the result.
2. Run the launcher: `scripts\safelight.cmd` on Windows, `scripts/safelight.sh` on macOS and Linux.

```
scripts\safelight.cmd help
scripts/safelight.sh version
```

`safelight` itself runs on Node 22 or newer. If `node` on your PATH is older, or missing, the launchers fall back to the Electron inside the repo. That works for every command except the interactive prompt: Electron's binary on Windows has no console, so typing `safelight` alone prints the help instead. Installing Node 22 fixes that. The pixel commands (`export`, `preview`) still run on Electron, found in the repo's `node_modules`; set `SAFELIGHT_ELECTRON` to a different Electron binary if you need one. `safelight doctor` shows which one it found.

On Windows, `build-scripts\build-safelight-unplugged.bat` ends by offering to install the `safelight` command. Say yes and it writes three small launchers (`safelight.cmd`, `safelight.ps1` and `safelight`) into npm's global folder, which every terminal already has on its PATH, including ones that were open before. Type `safelight` from anywhere. It leaves alone any `safelight` file there that it didn't write, and it removes the `scripts` folder from your user PATH if an older build added it. Everything below writes `safelight` for the launcher.

## Choosing photos

Most commands take photos first, then what to do to them.

| You type | It means |
|---|---|
| `IMG_4021.ARW` | That file. |
| `*.ARW`, `2026-11/**/*.RAF` | A pattern. `safelight` expands it itself, so it works the same in cmd, PowerShell and a Unix shell. It ignores case on Windows and macOS. `*` and `?` stay inside a folder, `**` crosses folders, and `{a,b}` picks one word. `[abc]` is not a pattern: brackets, and braces with no comma, match themselves. |
| `shoot/` or `.` | Every photo directly in that folder. Add `-r` to go into subfolders. |
| `--all` | Every photo in the project. |
| `--project <folder>` | Use that project instead of the one the photos sit in. |
| `--rating 3+`, `--rating 2-4` | Only photos with that rating. |
| `--flag pick`, `--label red` | Only photos with that flag or label. `none` matches the ones without. |
| `--edited`, `--unedited` | Only photos that have, or haven't, been edited. |
| `-` | Read photo paths from standard input, one per line. |
| `--` | Everything after it is a photo, even a name with an `=` in it. |

Filters narrow whichever of the others you gave. `safelight photos . --flag pick --rating 4+` lists the picks with four stars or more.

`safelight` finds the project the way the app does: it walks up from the photo to the nearest folder holding `.safelight/catalog.json`. A photo that isn't in a project is refused (exit code 2), because there is no catalogue to change. `safelight import` starts one (see Importing). A photo in a project that isn't imported yet is refused the same way, with the `import` command that fixes it.

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

Keys are the names the edit stores, so `safelight get IMG_4021.ARW --json` gives back what `safelight set` takes. Capitals don't matter, and `colour` matches `color` (`colourNR` finds `colorNR`). A misspelt key gets a "Did you mean" suggestion.

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

`safelight tools <photo>` lists the values a photo has with their ranges, and `safelight tools --all` includes idle tools.

Some things are shown but can't be set from `safelight`: the tone curve's points, masks, Heal spots, crop rectangles, guided Upright lines and paint layers. `safelight get` shows them, and `safelight set` says to edit them in Safelight.

Extension values are listed with their ranges (when the extension has been run in Safelight at least once) and can be reset or removed, but not set yet. `safelight set` answers "Local Contrast doesn't support safelight yet. Set it in Safelight." (or whichever tool it is).

## Commands

`safelight help` lists them in the groups below, and `safelight help <verb>` (or `safelight <verb> --help`) shows one command's usage and examples.

### Look

| Command | What it does |
|---|---|
| `safelight photos [photos] [filters]` | Lists photos: name, rating, flag, label, edited or not. |
| `safelight tools [photo] [--all]` | The tools in pipeline order. With a photo: each value with its range and unit, and a ✱ by values away from their default. |
| `safelight get <photo> [key…]` | The photo's values, all of them or the ones named. `--json` gives the current step as stored. |
| `safelight history <photo>` | The numbered steps with labels and times, the current one marked. |
| `safelight preview <photo> [--width cols] [--try key=value…] [--graphics mode]` | Prints the edited photo in the terminal. `--graphics` is `kitty`, `iterm`, `blocks` or `none`. `--try` renders with those values without storing them, and is required when you give `key=value`. |
| `safelight view [photo] [--browser \| --terminal] [--port n] [--no-open]` | Shows the photo live, in the browser or redrawn in the terminal, and again each time it changes. See Live view. |

### Library

| Command | What it does |
|---|---|
| `safelight ls [photos\|folders…] [-r] [--tree [--depth n]] [--grid] [--sort name\|date\|rating\|size\|edited\|imported] [--reverse] [filters]` | What is in a folder: subfolders with counts, then photos with their state, rating, flag, label and ✱ when edited. |
| `safelight import [photos\|folders…] [-r] [--copy [--into folder]] [--project folder] [--dry-run] [--quick] [--wait[=s]]` | Brings the catalogue up to date with the folder, as opening it in Safelight does. See Importing. |
| `safelight open [photos…] [filters] [--sort key] [--no-preview]` | Makes photos the working set and starts the prompt on them. See Opening photos. |
| `safelight rotate <photos> left\|right\|180` | Turns photos, as Library's rotate does. `cw`, `ccw`, `90`, `-90` and `270` also work. |
| `safelight keywords <photos> [--add word…] [--remove word…]` | Lists keywords, or adds and removes them. |
| `safelight forget <photos> [--yes]` | Removes photos from the catalogue. |

Library commands that change the catalogue are `import`, `rotate`, `keywords` (with `--add` or `--remove`), `forget`, and `open` when it has to import a photo first. They add no history step.

**`ls`** answers "what is in this folder", where `photos` answers "what is in the catalogue". It reads the disk, so it can show photos that aren't imported yet. With no path it lists the folder you are in. It never starts the engine, takes no lock, and works while Safelight has the project open.

- Each photo has a state: imported (the usual row), `not imported`, `removed from the catalogue` (you removed it; the file is still there), or `file missing` (a record whose file is gone, shown until the next import drops it).
- `-r` lists subfolders' photos too. `--tree` shows folders only, nested, with counts, down to `--depth n` levels. `--grid` draws a contact sheet where the terminal can show pictures.
- Besides the usual filters, `--new`, `--imported`, `--removed` and `--missing` pick a state. A catalogue filter such as `--rating` implies `--imported`.
- Files Safelight doesn't read are left out of the list and counted in the summary line.
- Outside any project it still lists the photos, each `not imported`, and says that `import` starts a catalogue.
- Exit code 0 when it listed, even if there were no photos; 2 when a named path doesn't exist, or 6 when only some didn't. Not a terminal, it prints one tab-separated line per entry.

**`rotate`** sets the photo's rotation and swaps its width and height on a quarter turn. The stored preview isn't turned; Safelight rebuilds it when it is next needed.

**`keywords`** with no flags lists each photo's keywords, then the project's keywords with counts when you name several photos. `--add "black sand" --add iceland` and `--remove draft` change them. Words are flags, never positionals, so a misspelt file name can't become a keyword. Keywords are stored flat, as typed.

**`forget`** removes the record, its edit history and its preview. The file stays, and no later import takes it back by itself; naming it in `import` does. A master takes its virtual copies with it. Photos that have edits need `--yes`, because their history is gone for good; without it the command stops with nothing changed (exit code 1). Unedited photos go without asking.

All four writing commands follow the usual rules: they take the writer lock for a moment, are refused with exit code 4 while Safelight has the project open (`--wait` waits), and with `--json` give a `photos` array with `ok`, `changed` and `changes` for each photo.

### Edit

| Command | What it does |
|---|---|
| `safelight set <photos> key=value…` | Sets values. One history step per photo, labelled with the values' names, as a slider move is. |
| `safelight add <photos> <tool>` | For a core tool, lists its keys; there is nothing to turn on. Extension tools can't be added from `safelight` yet. |
| `safelight remove <photos> <tool>` | Puts all the tool's values back to their defaults in one step. Works on extension tools too. |
| `safelight reset <photos> [key…]` | Resets the keys named, or with none everything `safelight` can set, in one step. With no keys it leaves the tone curve, masks, retouch spots, crop and guide lines alone, because `safelight` can't show or edit them, and says which of those it kept. |
| `safelight undo <photos> [n]`, `safelight redo <photos> [n]` | Moves back or forward `n` steps (default 1), as Undo and Redo do. |

### Share

| Command | What it does |
|---|---|
| `safelight copy <photo> [--tools a,b]` | Remembers a photo's settings. It leaves out the per-photo tools Paste Settings leaves out. |
| `safelight paste <photos> [--tools a,b] [--from <photo>]` | Applies the copied settings, one step per photo. `--from` copies and pastes in one go. |
| `safelight presets` | Lists the presets Safelight has saved, by group. |
| `safelight apply <preset> <photos>` | Applies a preset over the current values, one step per photo. |

`set`, `add`, `remove`, `apply` and `paste` take `--preview` to print the result in the terminal when exactly one photo changed.

### Organize

| Command | What it does |
|---|---|
| `safelight rate <photos> <0-5>` | Star rating. |
| `safelight flag <photos> pick\|reject\|none` | Flag. |
| `safelight label <photos> red\|yellow\|green\|blue\|purple\|none` | Colour label. |

Like in the app, these change the photo's record and add no history step. `rotate` and `keywords`, in Library above, work the same way.

### Output

| Command | What it does |
|---|---|
| `safelight export <photos> [-o dir\|file\|-] [options]` | Renders photos. The defaults are Preferences ▸ Export. |

`preview` also takes `--before` for the photo as it was at its first step, and `--step <n>` for any step.

Export options: `--format jpg\|png\|tiff\|webp`, `--quality 1-100` (JPEG and WebP), `--long-edge <px>` or `--size original`, `--colour-space srgb\|display-p3\|adobe-rgb\|prophoto-rgb`, `--bit-depth 8\|16` (PNG and TIFF), `--name <template id>` (a filename template an extension registered), `--existing number\|replace`, and `--try key=value…` (a `key=value` without `--try` is refused, since export stores nothing). A photo it can't find is reported and the rest are still exported, ending in exit code 6. `-o -` writes one image to standard output. Export writes image files, not the catalogue, so it works while Safelight has the project open.

### Extensions

| Command | What it does |
|---|---|
| `safelight search <words…>` | Searches the extension registry. |
| `safelight install <name>… [--version X] [--yes]` | Installs from the extension's release. For an extension that isn't verified, `safelight` shows what it may reach and asks. When nothing can answer (a script), it refuses unless you add `--yes`. A banned extension is refused. |
| `safelight uninstall <name>…` | Removes it. Photos keep its values. |
| `safelight update [name…]` | Updates the named extensions, or all with a newer release, from the repository `safelight` or Safelight installed each one from. An extension that isn't verified and asks for new permissions is asked about again, and refused when nothing can answer unless you add `--yes`. When `safelight` and Safelight installed one id from two different repositories, `safelight` can't tell which is current and leaves it alone: update it in Safelight. |
| `safelight extensions` | Installed extensions: name, id, version, on or off, trust, update available. |
| `safelight enable <name>…`, `safelight disable <name>…` | The same on/off switch as Safelight's. Until Safelight has been opened once, `safelight` can't see which extensions are on, so these refuse (exit code 5). |

A name can be an id (`local-contrast`, `safelight.basic`), the id without `safelight.`, the repository name, `owner/repo`, or the display name with dashes (`contrast-and-texture`). `safelight install essentials` installs a kit. A name that matches several extensions lists them and installs none. Installs, updates and removals take effect the next time Safelight starts.

### More

| Command | What it does |
|---|---|
| `safelight doctor` | The version, the app `safelight` runs with, the graphics backend, terminal image mode, the project lock for the current folder and extensions that failed to load. |
| `safelight version` | The version and process version. Same as `--version`. |
| `safelight help [verb]` | Help. Same as `-h` and `--help`. |

### Options every command takes

`--json`, `-q`, `-v` (`-vv` adds the engine's log; short flags can be joined, as in `-qv`), `--yes` (`-y`), `--strict`, `--wait[=seconds]`, `-h`, `--version`.

## Importing

Safelight has no import dialog: a project is a folder, and opening the folder is the import. New photos come in, photos that moved or were renamed keep their records, and records whose files are gone leave the catalogue. `safelight import` does exactly that. It isn't a second idea of import: it runs Safelight's own open in the engine, out of sight, so the records, previews and sidecars come out the same as when the app does it.

| You type | It does |
|---|---|
| `safelight import` | The whole project, in every subfolder. This is also the re-scan. |
| `safelight import Day2/` | Only the new photos directly in that folder. Add `-r` to take its subfolders. |
| `safelight import DSC_0500.NEF *.RAF` | Only those files. A file you removed from the catalogue is taken back when you name it. |
| `safelight import --copy ../elsewhere/IMG_1.ARW` | Copies the file into the project, then imports it. |
| `safelight import --dry-run` | Says what it would do, from the scan alone: how many photos are new and how many have files gone. It starts no engine. |

Every import also follows moved photos and drops records whose files are gone, even a partial one, so a renamed photo never keeps a stale record with its edits. The summary names the photos dropped and the ones found under a new name, and `--dry-run` shows them first.

**Photos outside the project.** A file that isn't inside the project is refused (exit code 2) with the fix. `--copy` copies each one into the project's top folder, or into a folder of it with `--into <folder>`, and imports it. It never moves a file and never overwrites one. A photo's `.safelight.json` sidecar is copied with it, so its ratings and edits come along. `--into` needs `--copy`.

**Starting a catalogue.** Where there is none, `import` starts one in the folder you are in, as long as that folder holds every file you named; otherwise name the folder with `--project <folder>`. It won't start one in a drive root, a share root or a home folder (exit code 2). A read-only folder, such as a memory card, gets a separate catalogue, as in the app, and the first line says where it is. It asks nothing; `--dry-run` is how to look first.

**Camera data.** A RAW is imported from its embedded preview, and its size and as-shot white balance are read from the whole file afterwards. `import` does that read for every photo in scope by default. `--quick` skips it and tells you how many are left; Safelight reads them in the background. Until a RAW's camera data is read, a first edit with `set` and the other edit commands is refused (exit code 2) with the `import` command that fixes it, because the edit would otherwise start from the wrong white balance. A photo that already has edits isn't affected.

**What it doesn't do.** It never fills the RAW cache. That speeds up the app's own opening, and the cache `safelight` fills lives apart from the app's, so it would only cost time and disk.

**Progress.** A live list of the files as they are read, a progress bar, then a summary: how many were imported, which couldn't be read, which left the catalogue and which moved. A photo imported with no preview yet counts as imported; the next import or Safelight retries the preview. Not a terminal, it prints one line per file. With `--json` it prints one document with `imported`, `failed`, `copied`, `moved` and `dropped`, and `stopped`, which is null, `"interrupted"` or `"safelight-opened"`.

**Ctrl+C stops it cleanly.** It is the same as Stop import in the app. The files already in flight finish, the rest are skipped, the catalogue is saved and the lock is given back. The command ends with exit code 130 and says how far it got. Run `safelight import` again to carry on from there. Press Ctrl+C a second time, or wait ten seconds, and the engine is stopped at once; at most the last ten seconds of progress is lost, and those files simply count as new again.

**If Safelight opens the folder meanwhile,** Safelight takes over, as it does from any program holding the lock. The import stops with exit code 4 and says how far it got, for example "Safelight opened Iceland 2026, so the import stopped after 137 of 412. Safelight imports the rest itself." Safelight's own open then takes in what was left, with no duplicates.

If Safelight already has the folder open when you start, `import` is refused before anything happens (exit code 4). Add `--wait` to wait for it to let go.

Exit codes: 0 everything in scope is imported; 1 usage (`--into` without `--copy`, or `--copy` with no files); 2 nothing could be imported (not found, not a photo, outside the project without `--copy`, a refused folder, a name `--copy` won't take); 3 the engine didn't start; 4 Safelight has the project open, or opened it; 6 some files couldn't be read or copied; 130 stopped with Ctrl+C.

## Pipes and batches

Pass all your photos to one command. A command that draws pictures (`export`, `preview` and `--preview`) starts an invisible copy of Safelight's engine, which takes a few seconds to start, so one command over a hundred photos is much faster than a hundred commands over one. Only one `safelight` engine runs at a time.

```
safelight set . --flag pick temperature=5400K exposure+=0.3 vibrance=15
safelight export . --rating 4+ -o ../web --long-edge 2048 --quality 82 -q
safelight photos . --rating 4+ --json | jq -r '.photos[].path' | safelight apply "Warm film" -
```

## Output and exit codes

Results go to standard output, in aligned columns with colour when it is a terminal and `NO_COLOR` isn't set. Warnings and progress go to standard error. `-q` prints errors only, and `-v` says what `safelight` did.

With `--json` a command prints one document, `{"slu": 1, …}`. A command over several photos gives a `photos` array with an entry for each, carrying `ok` or `error`. Keys are the stored keys and values are plain numbers, booleans and strings.

| Code | Meaning |
|---|---|
| 0 | Done. Clamping warnings don't change this. |
| 1 | Usage: an unknown command, key or option, or a value that doesn't fit. |
| 2 | A photo problem: not found, can't be decoded, not imported, or not in a project `safelight` can write to. |
| 3 | An engine problem: no graphics path, or the engine didn't start. |
| 4 | Busy: Safelight has the project open, or opened it while `import` ran. |
| 5 | An extension problem: name not found or ambiguous, refused, or the network. |
| 6 | Partly done: some photos in a batch failed. The output says which. |
| 130 | Stopped with Ctrl+C. Steps already written stay written. |

## When Safelight has the folder open

Safelight and `safelight` are separate programs, and two programs saving the same catalogue would lose changes. So only one writes at a time, and a `writer.lock` file in the project's `.safelight` folder says who.

- Commands that only read work anyway: `photos`, `ls`, `tools`, `get`, `history`, `preview`, `presets`, `export` and `doctor` show what Safelight last saved. So does `open` on photos that are already imported.
- Commands that change the catalogue are refused with nothing changed, exit code 4: `set`, `add`, `remove`, `reset`, `undo`, `redo`, `paste`, `apply`, `rate`, `flag`, `label`, `rotate`, `keywords` with `--add` or `--remove`, `forget`, `import`, and `open` when it has to import a photo first. Close the folder in Safelight, or add `--wait` to wait for it to let go (`--wait=60` gives up after a minute).
- While `safelight` is writing, Safelight opening the same folder waits a moment. For an edit that is milliseconds. For `import`, which holds the lock for the whole run, Safelight waits three seconds and then takes the lock over; the import stops cleanly (see Importing).
- Extension commands don't touch projects, so they aren't locked.

A lock left by a program that has closed or crashed on this computer counts as left over and is taken over at once. One held from another computer, for a project on a shared drive, is taken over once it hasn't been refreshed for 15 minutes.

## Live view

`view` keeps one photo on screen and shows it again whenever it changes, like a Develop window beside your typing.

```
safelight view DSC_0412.NEF --browser
```

- **In the browser** (`--browser`), `safelight` serves a page, opens it in your default browser and prints its address. `--no-open` only prints the address. `--port <n>` picks the port; otherwise any free one is used. The engine draws every frame, so any browser shows the same pixels as the app. Scroll or pinch to zoom around the pointer, drag to pan, and double-click to switch between fit and 100%: each zoom asks the engine for just that part of the photo, at the screen's resolution. Hold `\` to see the photo before its first edit; `F` fits it and `1` shows 100%. With photos open at the prompt, the left and right arrows step through them. The side panel lists the changed values, the history and the open photos. The page only shows: nothing in it changes a value.
- **In the terminal** (`--terminal`, and the default when the output is a terminal), each new picture is drawn over the last one on the same rows, with a line under it giving the image mode, how long the render took and the step. Once something else has been printed below it, the next picture is printed anew instead. `--width` and `--graphics` work as they do for `preview`.
- **Run once**, `safelight view <photo>` stays until Ctrl+C. It watches the project's catalogue, so an edit from another `safelight` command, in another terminal, or from Safelight itself shows up within a moment.
- **At the prompt**, `view` is a switch. It shows the open photo and follows `next`, `prev` and `open`, or keeps to the photo you name (`view DSC_0413.NEF`). After a command that changes that photo (`set`, `reset`, `undo`, `paste`, `apply`, `rotate` and the rest) it shows the result, on the prompt's engine. `view` again or `view off` turns it off, and so do `close` and leaving the prompt.

Renders go newest first: while one renders, only the newest change waits, so a quick run of edits draws once at the end.

The page is served on this computer only (127.0.0.1), at an address with a random part that changes every time, and nothing else is answered. Anyone on this computer who has the address can see the photo, so keep it to yourself.

## Preview limits

`preview` and `--preview` draw into the terminal's text, so they show a photo's look, not its pixels.

- A terminal that speaks the kitty or iTerm2 image protocols shows the real picture. Others get coloured blocks, which are coarse. `--graphics` chooses.
- On Windows `safelight` recognises Windows Terminal and shows blocks. The line under the picture says the mode and warns when the colour isn't true colour.
- It is a small picture, scaled to fit. Judge detail and colour in Safelight or in an exported file.

## What's not in this release

- `auto` (Auto Tone and Auto White Balance) and `save-preset` are not built yet. `save-preset` says to save presets in Safelight.
- Setting an extension's values, and `add` for an extension tool. They can be listed, reset and removed.
- The tone curve's points, masks, Heal, crop ratios, guided Upright and paint layers.
- Deleting photos to the trash, renaming, virtual copies, stacks, and a side-by-side compare. `forget` removes from the catalogue only.
- Sixel images, and running several commands against one warm engine.
- Attaching to a running Safelight, so changes appear live.
- Packaged launchers, a `safelight` on your PATH from an installer, and shell completion.
- Extensions' own commit hooks. They are skipped, with a warning; `safelight doctor` lists the extensions that have them.
