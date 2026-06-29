# Extensions — safety & terms

Safelight is built so that most features are **extensions**: small packages that add
panels, tools, themes, processing stages, importers, and more. The core app is a "blind
orchestrator" and extensions fill it in.

This document covers what extensions are, the safety model, and the terms that apply
when you install one or list one in the store. For how to *use* extensions, see the
[Using Extensions guide](docs/user/using-extensions.md).

## Extensions are third-party software

Except for the small set bundled with the app, extensions are **independent third-party
software**. They are ordinary GitHub repositories (tagged `safelight-extension`) that
install **straight from source** and run **with full access to your photos, metadata,
edits, and files** — the same access the app itself has.

Safelight does not write, control, host, or guarantee third-party extensions. Their
authors are solely responsible for them. **Install extensions at your own risk**, using
the same judgement you'd apply to a browser extension or an IDE plugin.

## The trust registry (verified / banned)

To help, Safelight consults a community
[trust registry](https://github.com/anthonyreimche/safelight-registry):

- **Verified** — a maintainer reviewed the repo's code *at a point in time* and didn't
  find it doing anything malicious. **This is not an endorsement or a guarantee of
  safety.** When the registry pins the reviewed version, Safelight shows a plain green
  badge only while the published version matches it; once the repo publishes a newer,
  unreviewed version, that shows an **amber badge and prompts before install/update**. A
  verified extension still runs with full access.
- **Banned** — a best-effort remote kill-switch: extensions reported and assessed as
  malicious are refused at install and disabled at load, even if already installed. The
  ban list **cannot be guaranteed complete or current.**

You can require verified-only installs in **Preferences ▸ Extensions ▸ Only verified
extensions**. The registry is a best-effort safety aid, **provided as-is with no
warranty**.

## Permissions

Extensions can declare the capabilities they need in `safelight.json`:

```json
{
  "permissions": {
    "network": ["https://api.example.com"],
    "reason": "Uploads selected photos to your gallery."
  }
}
```

- **`network` is enforced.** Only the HTTPS origins an installed extension declares
  are added to the app's content-security policy; an extension **cannot reach a host
  it didn't declare** — the request is blocked. A new declaration takes effect on the
  next launch, so installing a network-using extension asks you to restart before it
  can connect. Declared origins are shown on the extension's store page and after
  install.
- **Everything else is disclosure, not a sandbox.** Because extensions run inside the
  app, they have ambient access to your catalog, photos, and files no matter what they
  declare; only network egress is technically confined. Permissions help honest
  extensions be transparent and let you make an informed choice — they do not stop a
  determined malicious extension from misusing the in-app access every extension has.
  Install only extensions you trust.

## No warranty

Safelight, its extension store, and the trust registry are provided **without warranty
of any kind**, to the maximum extent permitted by law. To that same extent, the
Safelight author is **not liable** for any damage, data loss, privacy loss, or other
harm arising from third-party extensions you choose to install or from your use of the
store/registry. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## For extension authors

- Publish your extension in your own repository, tagged `safelight-extension`, with a
  valid `safelight.json`. It is your work under your own license.
- To request a Verified badge, or to report or **appeal** a ban, see the
  [registry README](https://github.com/anthonyreimche/safelight-registry).
- Listing, verification, and removal are at the maintainer's discretion. The store
  surfaces public GitHub repos; Safelight may decline or remove a listing, and ban
  reasons reflect the registry's good-faith assessment of observed behavior.

## Reporting a malicious extension

Report it through the
[registry](https://github.com/anthonyreimche/safelight-registry) (open an issue, or a PR
to `banned.json`) or email **anthonyreimche@gmail.com**. Once assessed, a ban disables
the extension everywhere on the next launch — no app update required.
