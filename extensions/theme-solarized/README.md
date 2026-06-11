# Solarized Themes for Safelight

Adds **Solarized Dark** and **Solarized Light** to View ▸ Theme and
Preferences ▸ Interface ▸ Theme.

## Install (testing, local)

Copy this folder into the app's plugin directory and restart Safelight:

```
%APPDATA%\Safelight\plugins\theme-solarized\
```

(The folder name must match the manifest `id`: `theme-solarized`.)

## Install (official)

Push this folder to its own GitHub repo, add the **`safelight-extension`**
topic to the repo, and it will appear in the Extensions panel's official
browser. It can also be installed manually as `owner/theme-solarized`.

No build step — `dist/index.js` is plain ESM registering two themes through
`api.registerTheme`.
