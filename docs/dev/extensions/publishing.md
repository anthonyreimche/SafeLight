# Publishing & Store Listing

← [Building Extensions](README.md)

The Extensions store builds your page from your repo. You don't host anything.

## Thumbnail

**Browse grid:** each card shows your manifest `icon`, or else the owner's avatar. Declaring an icon is the only way to get a distinct thumbnail in the grid.

- Add `"icon": "icon.png"` to `safelight.json`: a path relative to the repo's default branch, or an absolute `https:` URL. Square, about 256×256, reads best.

**Detail view:** uses the first available of the manifest `icon`, the repo's GitHub social preview (Settings ▸ General ▸ Social preview, 1280×640), and the owner's avatar.

## README

Your repo's `README.md` is rendered on your store page, with relative image links resolved against the default branch. It is the main description users read, so lead with what the extension does and a screenshot.

## Metadata

`description`, `author`, `categories`, `keywords`, `license`, `homepage`, `screenshots`, `worksWith` and `minAppVersion` from the [manifest](README.md#manifest) fill the listing. Stars, last update and open issues come live from GitHub. `categories` picks the store category over repo topics (see [Store listing](README.md#store-listing)), and `minAppVersion` blocks installs on older Safelight builds.

## Releases and versions

Safelight installs and updates an extension from its newest **GitHub Release** when the repo has one, and from the default branch when it has none.

- **Before your first release**, every push to the default branch reaches users: the store reads `version` from the branch's `safelight.json` and offers anything newer.
- **Once you publish a release**, pushes to the branch stop reaching users. Installs and updates come from releases only, so you can work on the branch freely and ship by tagging.

**Tag = version.** Tag a release with the manifest's version, with or without a `v` (`v1.3.0` or `1.3.0`). The `version` in `safelight.json` at that tag must match: Safelight refuses a release that says otherwise. Tags that aren't versions (`nightly`) and drafts are ignored.

**Release notes** show on your store page under "What's new" and in the Updates tab, so write them for users.

**Pre-releases.** Mark a release as a pre-release, or tag it like `v1.4.0-beta.1`. Safelight installs one only when a user picks it from the version list. After that, they're offered newer pre-releases until a full release passes them.

**What gets installed.** Safelight uses the first `.zip` asset with `safelight.json` at its root, or inside a single top-level folder. The zip must hold everything loaded at runtime: the `main` bundle and any file reached through `/__plugins__/<id>/` (icons, LUTs, WASM). With no such zip, Safelight installs the source tree at the tag, which works when you commit `dist/`.

**Older versions.** Users can install any of your releases from the version list and stay on it. Keep old releases published: deleting one removes it from that list.

**Timing.** The store learns about new releases from the extension registry, which rebuilds hourly, so a release reaches users within about two hours. The ↻ button beside the version list asks GitHub straight away.

### Automating releases

[`release-workflow.yml`](release-workflow.yml) is a GitHub Actions workflow that does all of this when you push a tag starting with `v`. Copy it to `.github/workflows/release.yml` in your repo and set `RELEASE_FILES` at the top to what your extension needs at runtime, including the `main` file. Then:

```bash
git tag v1.3.0
git push origin v1.3.0
```

It builds (`npm ci` and `npm run build`, when your repo has them), fails if `safelight.json` doesn't match the tag or the `main` bundle is missing, zips `RELEASE_FILES`, and publishes the release with generated notes. A tag with a `-` becomes a pre-release. If you created the release on GitHub first, the workflow attaches the zip to it.

## Get it listed

Tag the GitHub repo with the **`safelight-extension`** topic so it appears in the store's browse view. Users can also install any repo by `owner/repo` without the topic.
