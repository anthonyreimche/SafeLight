// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What's new: the changelog's notes for the releases since the last launch,
// shown once after an update and from Preferences ▸ About.

import { useEffect } from "react";
import { Markdown } from "@/extensions/Markdown";
import { Button } from "@/extensions/ui-kit";
import { ModalWindow } from "@/ui/components/ModalWindow";
import { pushEscapeHandler } from "@/ui/escape-stack";
import { openUrl } from "@/update/update-checker";
import type { ChangelogRelease } from "./changelog";
import { CHANGELOG_URL, closeWhatsNew, useWhatsNew } from "./whats-new-store";

const BOX =
  "flex max-h-[90vh] w-[680px] max-w-[94vw] flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-2xl";

const dateOf = (iso: string): string => {
  const t = Date.parse(`${iso}T12:00:00`);
  return Number.isFinite(t)
    ? new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
    : "";
};

export function WhatsNewDialog() {
  const releases = useWhatsNew((s) => s.releases);
  return releases ? <WhatsNewWindow releases={releases} /> : null;
}

function WhatsNewWindow({ releases }: { releases: ChangelogRelease[] }) {
  useEffect(() => pushEscapeHandler(closeWhatsNew), []);
  const title = releases.length === 1 ? `What's new in Safelight ${releases[0].version}` : "What's new in Safelight";
  return (
    <ModalWindow title={title} onClose={closeWhatsNew} boxClassName={BOX}>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        {releases.map((release) => (
          <section key={release.version} className="space-y-3">
            <h2 className="flex items-baseline gap-2 text-[13px] font-semibold text-text-primary">
              {release.version}
              {release.date && <span className="text-[11px] font-normal text-text-muted">{dateOf(release.date)}</span>}
            </h2>
            {release.groups.map((group) => (
              <div key={group.title} className="space-y-1">
                <h3 className="text-[11px] font-medium text-text-primary">{group.title}</h3>
                <Markdown source={group.items.map((item) => `- ${item}`).join("\n")} />
              </div>
            ))}
          </section>
        ))}
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-surface-2 px-4 py-3">
        <Button onClick={() => openUrl(CHANGELOG_URL)}>All changes</Button>
      </div>
    </ModalWindow>
  );
}
