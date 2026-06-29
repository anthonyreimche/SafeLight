# NLnet / NGI Zero — Application Draft (Safelight)

> **Working draft.** NLnet's [application form](https://nlnet.nl/propose/) is short
> free-text fields, not a long PDF. This file maps each form field to a ready
> answer you can paste and trim. Replace every **[bracketed]** placeholder.
> Aim for concise — NLnet explicitly prefers short, concrete proposals over
> marketing. Apply to the **NGI Zero Commons Fund** (the broadest, best-fit call;
> rolling deadlines, typically the 1st of even months — check the site).
>
> Consider keeping this file out of the public repo (it contains budget/personal
> info). Move it somewhere private before committing, or add it to `.gitignore`.

---

## Project name

Safelight

## Website / repository

https://github.com/anthonyreimche/SafeLight

## Abstract — "explain the whole project and its expected outcome" (~1200 chars)

> Tighten to ~1200 characters before submitting.

Safelight is a free, open-source (GPLv3) RAW photo editor for desktop, built to
give photographers full ownership of their editing workflow — without the
subscription lock-in, cloud dependency, or closed ecosystems that dominate this
space (Adobe Lightroom et al.).

Its defining design is a **"blind orchestrator" architecture**: the core app is
deliberately minimal and knows nothing about specific tools. Every panel, theme,
and even GPU image-processing operation is a contribution registered through one
public extension API — the same API third parties use. Built-in develop tools
are just pre-installed extensions. This makes the entire editor an open,
inspectable, replaceable commons: anyone can build, swap, or fork any part of the
imaging pipeline without forking the app, and there is no privileged gatekeeper.

Everything runs locally — RAW decoding, WebGL/GPU rendering, and (planned)
on-device AI masking — with no telemetry and no required cloud account.

The outcome of this grant is to complete the open GPU processing-stage framework,
ship a documented extension SDK, and add on-device AI masking, turning Safelight
into a genuinely community-extensible, privacy-respecting alternative to
proprietary RAW editors.

## Have you been involved with relevant projects before? What are your skills?

> Personalize — this is where you establish credibility. Keep it factual.

[Your background: years of software development, relevant imaging/graphics/WebGL
experience, prior open-source work, photography background.]

Safelight itself is the primary evidence: a working cross-platform RAW editor I
designed and built solo, covering RAW decode for multiple camera formats, a
WebGL rendering engine running in a Web Worker on an OffscreenCanvas, GPU shader
pipelines, color science (including an ISO-12646 color-assessment mode and a
spectral film-simulation engine), a Lensfun-derived lens-correction database, and
a full extension/plugin system with an in-app store. Skills: TypeScript, React,
WebGL/GLSL, Electron, image processing and color science, GPU programming.

## Requested amount

€ **[total, e.g. 30,000]**

> NGI Zero individual grants commonly land in the €5k–€50k range. Smaller,
> milestone-scoped asks are approved more readily. Pick the milestones below that
> fit your target and drop the rest.

## What will the budget be used for? Other funding sources?

Funding is requested per concrete, independently-deliverable milestone. There is
no other funding; the project is currently unfunded and maintained by one person.
Optional community support (GitHub Sponsors) covers nothing close to development
cost.

| # | Milestone / deliverable | Est. effort | Amount |
| - | ----------------------- | ----------- | ------ |
| 1 | **Open GPU processing-stage framework, completed.** Migrate all remaining built-in develop tools to the public extension-contributed GPU stage API, so core and third-party processing are true equals. Public spec + reference stages. | [N weeks] | € [____] |
| 2 | **Extension SDK & scaffolding.** Project templates, a CLI/scaffold, end-to-end API docs, and example extensions, so an outside developer can ship a new tool or theme without reading core source. | [N weeks] | € [____] |
| 3 | **On-device AI masking.** Local, private subject/sky selection via ONNX runtime in the render path — no cloud, no data leaving the machine. | [N weeks] | € [____] |
| 4 | **Accessibility & internationalization pass.** Complete the opt-in accessibility overlay system to meet WCAG AA where appropriate, plus i18n scaffolding for translation. | [N weeks] | € [____] |
| 5 | **Open imaging-data pipeline.** Improve open lens/camera-profile ingestion and the open-format RAW/decode coverage; document the data formats. | [N weeks] | € [____] |
|   | **Total** | | € **[total]** |

> NLnet pays on completion of each milestone against agreed deliverables, so each
> row should be something a reviewer can verify as "done."

## Compare with existing or historical efforts

- **Adobe Lightroom / Capture One** — the incumbents. Proprietary,
  subscription-based, closed pipelines, cloud-coupled. Safelight is the
  sovereignty-respecting opposite: free, GPLv3, local-first, no subscription.
- **darktable / RawTherapee** — excellent open-source RAW editors, and the
  closest peers. Safelight's distinction is **architectural**: a "blind
  orchestrator" where *all* functionality — including GPU processing stages — is
  an extension through one public API, with an in-app extension store and a
  defined trust model. The goal is not just an open editor but an open *platform*
  for imaging tools, lowering the barrier for others to contribute or experiment
  without forking.
- Safelight is also built on modern, portable web technology (WebGL, runs in a
  browser or Electron), making the pipeline inspectable and the project easy to
  contribute to.

## Significant technical challenges

- Making GPU image-processing stages fully extension-contributable (custom
  shaders, uniforms, multi-pass prepasses, LUT/texture binding) while keeping the
  render pipeline correct and fast — without the core knowing what any stage does.
- Running AI masking models on-device (ONNX) inside a worker render path, with
  acceptable performance and zero network dependency.
- Reliable cross-platform RAW decoding across many camera formats from open
  sources.
- Color-science correctness (spectral film simulation, ISO-12646 assessment)
  implemented on the GPU.

## Ecosystem & dissemination

Safelight is GPLv3 (inbound = outbound contributions) with a public extension API and store
(GitHub-backed). Engagement plan: publish the extension SDK and templates so
photographers and developers can build and share extensions (discoverable via the
`safelight-extension` GitHub topic); write technical articles on the imaging/color
work (e.g. the spectral film simulation) to reach the graphics/photography
communities; and release all grant deliverables as free upstream features under
the GPL. Sponsorware funding releases features to the whole commons once funded.

## Which NGI topic does this relate to?

NGI Zero **Commons Fund** — open-source software that strengthens digital
commons and user sovereignty: a free, local-first, privacy-respecting,
fully-extensible alternative to closed, subscription, cloud-coupled creative
software, with an open platform model that lets a community own and extend its
own tools.

---

### Submission checklist
- [ ] Trim Abstract to ~1200 chars
- [ ] Fill personal background + skills honestly
- [ ] Decide total amount and fill the milestone budget table
- [ ] Pick the correct open call + deadline on nlnet.nl
- [ ] Move this file out of the public repo (or `.gitignore` it) before committing
