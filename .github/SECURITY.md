# Security Policy

## Reporting a vulnerability

Please report security issues **privately**, not in a public issue.

- Preferred: GitHub's **private vulnerability reporting** (the "Report a
  vulnerability" button on the repository's Security tab), or
- Email **anthonyreimche@gmail.com** with details and, if possible, a proof of
  concept.

You will get an acknowledgement within about **7 days**. Please allow a
reasonable window to investigate and ship a fix before any public disclosure.
Coordinated disclosure is appreciated, and reporters are credited unless they ask
otherwise.

## Scope

Safelight is built by one person and is offered with no warranty (see
[LICENSE](../LICENSE)), but security reports are taken seriously. Areas of
particular interest:

- **RAW and image decoding** — Safelight parses untrusted image files, including
  through the bundled LibRaw WebAssembly decoder and in-house TIFF/CFA/NetPBM
  paths. Memory-safety or parser issues here are in scope.
- **Extensions** — extensions are third-party JavaScript loaded from GitHub repos
  the user chooses. Issues in the extension **host, loader, trust model, or
  privileged bridge** (sandbox escapes, privilege escalation to raw filesystem or
  the update installer) are in scope. The behavior of an individual third-party
  extension is the responsibility of its author.
- **Electron shell** — IPC surface, CSP, and protocol handling in `electron/`.

## Supported versions

Fixes are made against the latest release. There are no long-term support
branches; please update to the newest build.
