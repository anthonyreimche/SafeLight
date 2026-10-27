# Camera profile tables

This tool packs Adobe's DNG camera profiles (DCPs), installed with Adobe Camera
Raw, Lightroom or the free Adobe DNG Converter, into Safelight's camera profile
tables (`.slcp`, read by `src/rendering/camera-profiles/format.ts`). Only
profiles tagged ProfileEmbedPolicy 0 ("allow copying") are included, with
Adobe's copyright notice in a `NOTICE.md` beside the tables. Each camera's
BaselineExposure is read from a DNG that Adobe's DNG Converter made from one
sample RAW of that camera.

## Not shipped

Adobe's profiles are ProfileEmbedPolicy 0, which the DNG specification limits to
processing DNG files, and Safelight processes native RAWs. The tables are for
local research only. They go to `build-scripts/camera-profiles/out/`
(git-ignored), and the tool refuses to write under `public/`, which ships with
the app. Neither the tables nor the baselines measured with Adobe's converter
(`baselines.local.json`, git-ignored) may be committed or shipped.

## Generate

Needs Node 22.6 or later (for `--experimental-strip-types`) and an Adobe install
with camera profiles. Measuring baselines needs the Adobe DNG Converter
(Windows or macOS). Run it from the repo root in PowerShell (Git Bash rewrites
`D:` paths before the converter sees them). Measured baselines are saved to the
git-ignored `build-scripts/camera-profiles/baselines.local.json`, which must not
be committed:

```powershell
node --experimental-strip-types build-scripts/camera-profiles/build.ts `
  --adobe "C:\ProgramData\Adobe\CameraRaw\CameraProfiles" `
  --label "test library" --samples "D:\Photos\2026\Safelight tests\raw tests" `
  --label library --samples "D:\Photos\2026\2026 05 19"
```

The run lists the cameras still without a measured baseline, camera-style
bodies first. Add a sample RAW of one (raw.pixls.us has most cameras) and run
again; measured cameras are never converted again.

## Options

- `--adobe <folder>` (required): Adobe's `CameraProfiles` folder, holding
  `Camera/` and `Adobe Standard/`.
- `--samples <folder>`: a folder of sample RAWs to measure. Repeat it for more
  folders.
- `--label <text>`: where the samples after it came from, such as `library` or
  `raw.pixls.us`. It is recorded with each measured baseline and applies to
  every `--samples` that follows until the next `--label`. Defaults to
  `samples`.
- `--out <folder>`: where the tables go. Defaults to
  `build-scripts/camera-profiles/out`. A run clears it first, so it must be
  empty, missing or a previous output. A folder holding other files, or
  anything under `public/`, is refused.
- `--baselines <file>`: the measured baselines to read and update. A missing
  file means none are measured yet, and the run creates it. Defaults to the
  git-ignored `build-scripts/camera-profiles/baselines.local.json`. Keep it out
  of `--out`, which a run clears.
- `--dng-converter <exe>`: the Adobe DNG Converter to measure with. Defaults to
  `C:\Program Files\Adobe\Adobe DNG Converter\Adobe DNG Converter.exe` when it
  exists. Without a converter, samples are skipped (each is reported) and only
  baselines already in the file count. A path that doesn't exist is an error.
- `--source <text>`: the description written into `index.json` as the tables'
  source. Defaults to `Adobe Camera Raw profiles`.
