# Publishing & Store Listing

← [Building Extensions](README.md)

The Extensions store builds your detail page from your repo — you don't host anything. Three inputs drive it.

## Thumbnail / icon

The detail view picks the first available of: `manifest.icon` → the repo's **og:image** (GitHub social preview) → the owner's avatar. So you have two ways to set a deliberate thumbnail:

- Add `"icon": "icon.png"` to `safelight.json` (a path relative to the repo's default branch, or an absolute `https:` URL). Square, ~256×256 reads best at the 48×48 the store renders it.
- Or upload a **custom social preview** under the repo's *Settings ▸ General ▸ Social preview* (1280×640). With no manifest icon, Safelight uses this; with none uploaded, GitHub's auto-generated card is used as a last resort. (The store's CSP allows remote `https:` images for exactly this.)

## README

Your repo's `README.md` is fetched and rendered on the detail page (relative image links resolve against the default branch). This is the main description users read — lead with what the extension does and a screenshot.

## Metadata

`description`, `author`, `categories`, `keywords`, `license`, `homepage`, `screenshots`, and `minAppVersion` from the [manifest](README.md#manifest) enrich the listing; stars / last-updated / open-issues come live from GitHub. `categories` drive the store's category chips (preferred over repo topics). `minAppVersion` blocks installs on older Safelight builds.

## Get it listed

Tag the GitHub repo with the **`safelight-extension`** topic so it appears in the in-app store's browse view. (Users can also install any repo directly by `owner/repo` even without the topic, but the topic is what surfaces it to everyone.)
