# Publishing & Store Listing

← [Building Extensions](README.md)

The Extensions store builds your detail page from your repo — you don't host anything. Three inputs drive it.

## Thumbnail / icon

**Browse grid:** each card shows your `manifest.icon` if you declare one, otherwise the owner's avatar. The icon is served straight from the jsDelivr CDN (so the grid paints instantly and isn't throttled) — declaring one is the only way to get a distinct thumbnail in the browse view.

- Add `"icon": "icon.png"` to `safelight.json` (a path relative to the repo's default branch, or an absolute `https:` URL). Square, ~256×256 reads best.

**Detail view:** picks the first available of `manifest.icon` → the repo's **og:image** (GitHub social preview) → the owner's avatar. So in addition to the manifest icon, you can upload a **custom social preview** under the repo's *Settings ▸ General ▸ Social preview* (1280×640) for the detail header; with neither, the avatar is used. (The store's CSP allows remote `https:` images for exactly this.)

## README

Your repo's `README.md` is fetched and rendered on the detail page (relative image links resolve against the default branch). This is the main description users read — lead with what the extension does and a screenshot.

## Metadata

`description`, `author`, `categories`, `keywords`, `license`, `homepage`, `screenshots`, and `minAppVersion` from the [manifest](README.md#manifest) enrich the listing; stars / last-updated / open-issues come live from GitHub. `categories` drive the store's category chips (preferred over repo topics). `minAppVersion` blocks installs on older Safelight builds.

## Releases and versions

Safelight installs and updates an extension from its newest **GitHub Release** when the repo has one, and from the default branch when it has none.

- **Before your first release**, every push to the default branch reaches users: the store reads `version` from the branch's `safelight.json` and offers anything newer.
- **Once you publish a release**, pushes to the branch stop reaching users. Installs and updates come from releases only, so you can work on the branch freely and ship by tagging.

**Tag = version.** Tag a release with the manifest's version, with or without a `v` (`v1.3.0` or `1.3.0`). The `version` in `safelight.json` at that tag must match the tag: Safelight refuses a release that says otherwise and doesn't offer it as an update. Tags that aren't versions (`nightly`) are ignored, and so are drafts.

**Release notes** show on the extension's store page under "What's new" and in the Updates tab, so write them for users. GitHub's "Generate release notes" button is a fine start.

**Pre-releases.** Mark a release as a pre-release, or give it a tag like `v1.4.0-beta.1`. Safelight never installs a pre-release unless someone picks it from the version list; after that, they're offered newer pre-releases until a full release passes them.

**What gets installed.** Safelight looks at the release's `.zip` assets in order and uses the first one with `safelight.json` at its root, or inside a single top-level folder. The zip must hold everything the extension loads at runtime: the `main` bundle and any file it reaches through `/__plugins__/<id>/` (icons, LUTs, WASM). With no such zip, Safelight installs the source tree at the tag, which works when you commit `dist/`. Once your releases carry a zip, you can stop committing `dist/`.

**Older versions.** Users can install any of your releases from the version list on your store page and stay on it. Keep old releases published; deleting one removes it from that list.

**Timing.** The store learns about a new release from the Safelight extension registry, which rebuilds hourly, so a release reaches users within about two hours. The ↻ button beside the version list on your store page asks GitHub straight away.

### Automating releases

[`release-workflow.yml`](release-workflow.yml) is a GitHub Actions workflow that does all of this when you push a tag that starts with `v`, such as `v1.3.0`. Copy it to `.github/workflows/release.yml` in your repo and set `RELEASE_FILES` at the top to what your extension needs at runtime, which must include the manifest's `main` file. Then:

```bash
git tag v1.3.0
git push origin v1.3.0
```

It builds (`npm ci` and `npm run build`, when your repo has them), fails if `safelight.json` doesn't match the tag or the `main` bundle is missing, zips `RELEASE_FILES`, and publishes the release with generated notes and the zip attached. A tag with a `-` is published as a pre-release. If you created the release on GitHub first, the workflow attaches the zip to it instead.

## Get it listed

Tag the GitHub repo with the **`safelight-extension`** topic so it appears in the in-app store's browse view. (Users can also install any repo directly by `owner/repo` even without the topic, but the topic is what surfaces it to everyone.)
