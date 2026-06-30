# SafeLight GitHub Automation

Four workflows turn issues into a prioritized to-do list and turn tags into installers.

## What runs when

| Workflow | File | Trigger | Does |
|---|---|---|---|
| Sync Labels | `sync-labels.yml` | manual, or edit to `labels.json` | Creates/updates the label set |
| Triage Issues | `triage.yml` | issue opened/edited/reopened | Adds type/area/priority labels (plus `extension` for `Extension:`-titled issues), assigns a milestone |
| Project Board | `project.yml` | issue/PR opened/labeled | Adds it to your board, sets the Priority field |
| Release | `release.yml` | push a `v*` tag | Builds Win/mac/Linux installers, attaches to a Release |

## One-time setup

### 1. Create the labels
Actions tab → **Sync Labels** → *Run workflow*. (Also runs whenever you edit `.github/labels.json`.)

### 2. Create the Project board (the to-do list)
1. Your profile → **Projects** → **New project** → *Board* template.
2. Add a field named exactly **Priority** (type: *Single select*) with options whose names contain
   `Critical`, `High`, `Medium`, `Low` (e.g. "🔴 Critical"). The triage labels map onto these by name.
3. Copy the board URL, e.g. `https://github.com/users/anthonyreimche/projects/3`.

### 3. Wire the board to the repo
- **Repo → Settings → Secrets and variables → Actions → Variables**: add `PROJECT_URL` = your board URL.
- **Same page → Secrets**: add `ADD_TO_PROJECT_PAT` = a **classic** Personal Access Token
  (Settings → Developer settings → Tokens (classic)) with scopes **`repo`** and **`project`**.
  GitHub's built-in `GITHUB_TOKEN` can't write to user-level Projects, which is why this PAT is needed.

If `PROJECT_URL` is absent the board job simply no-ops — labels and releases still work.

## Daily flow

1. Someone opens an issue → it's auto-labeled, prioritized, milestoned, and dropped on the board.
2. You open the board, sort by Priority, and work the top of the list.
3. Merge the PR (linking the issue with `Closes #123` auto-closes + removes it from the active list).
4. Cut a release: `git tag v1.0.6 && git push origin v1.0.6` → installers appear on the Releases page.

## Priority → milestone buckets

| Priority label | Milestone |
|---|---|
| critical / high | 🚀 Next Release |
| medium | 📋 Backlog |
| low | 💤 Someday |

Milestones are created automatically on first use. The triage job only moves an issue
between these three buckets, so a milestone you set by hand (e.g. `v1.1`) is left alone.

## Code signing (optional)

Releases build **unsigned** by default (`CSC_IDENTITY_AUTO_DISCOVERY=false`) so CI never blocks.
To sign Windows builds, add secrets `CSC_LINK` (base64 of your `.pfx`) and `CSC_KEY_PASSWORD`,
then remove the `CSC_IDENTITY_AUTO_DISCOVERY` line for the Windows leg. macOS notarization needs
an Apple Developer ID plus `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` secrets.

## Tuning the heuristics

Keyword lists live inline in `triage.yml` (`has(...)` calls). Add words to a bucket to change
how titles/bodies are classified. Label names/colors live in `.github/labels.json`.

Extension proposals are tagged `extension` automatically when the issue title starts with
`Extension:` — that label is what the [Roadmap](../ROADMAP.md) filters on.
