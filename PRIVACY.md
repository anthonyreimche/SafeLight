# Privacy

Safelight is built to keep your work on your machine. There are no accounts, no
analytics, no behavioral telemetry, and no crash reporting. Your photos, edits,
ratings, and catalog stay in the project folder you open (in a hidden
`.safelight/` directory) and are never uploaded by the core app.

This document describes **every** network request the app can make, so the
description matches the behavior. It is written to be accurate rather than
reassuring; where the app contacts the network, it says so plainly.

## What the core app sends over the network

All of the following contact GitHub only. The only personal data involved is
your **IP address** (unavoidable for any HTTP request) and the **app/extension
version** being compared. None of it is stored or processed by the author — it
is sent directly to GitHub, whose terms govern it.

| Feature | Endpoint | When | Default | How to turn off |
|---|---|---|---|---|
| App update check | `api.github.com/.../releases` | On launch, then every 3h | **On** | Preferences → Updates → "Check for updates" |
| Extension update check | `api.github.com` (per installed extension) | On launch, then every 3h | **On** | Preferences → Extensions → "Check for extension updates" |
| Extension trust list | `raw.githubusercontent.com/.../safelight-registry` | On launch, if any extension is installed | **On**, gated by the extension-update setting above | Same toggle as extension updates |
| Extension store browsing | `api.github.com/search`, plus thumbnails from `github.com`, `cdn.jsdelivr.net`, and avatar hosts | Only when you open the Extensions window and search | User-initiated | Don't open the store |
| Installing / updating an extension | The extension's GitHub repo | Only when you click install/update | User-initiated | Don't install |

**Going fully offline:** turn off both "Check for updates" and "Check for
extension updates" in Preferences. With those off, the core app makes no network
request unless you explicitly open the Extensions store or install an extension.

## Extensions can do more

Extensions are third-party code you choose to install, and an extension can make
its own network requests. In particular, the optional **Web Tools** extension can
**upload your photos** to a gallery/proofing service so you can share them — that
is its purpose, and those images leave your machine when you use it. The core
app's content-security policy permits extensions to send data to Cloudflare
Worker hosts (`*.workers.dev`) for exactly this reason.

If you publish to a gallery, the service operating that gallery is a separate
data processor with its own terms; a public gallery is, by definition, visible to
others. Extensions are independent third-party software that Safelight does not
control or guarantee; only install extensions you trust. See
[Extensions — safety & terms](EXTENSIONS.md).

## Exports and metadata

Exported images **do not** carry your camera EXIF, GPS/location, or XMP metadata
— those are stripped. Wide-gamut exports (Display P3, Adobe RGB, ProPhoto) embed
a standard **ICC color profile** so colors render correctly in other software;
that profile is a technical color description and contains no personal or
device-identifying information.

## Your local data

Everything Safelight stores about your work lives in the project's `.safelight/`
folder: the catalog, edit histories, thumbnails, and the RAW decode cache.
Deleting that folder removes Safelight's data and nothing else. Your original
image files are never modified.

## Questions

For privacy questions or data requests, contact **anthonyreimche@gmail.com**.

*This document describes the app's behavior and is not a contract. It may change
as the app changes; the version in your installed build describes that build.*
