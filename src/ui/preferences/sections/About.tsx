// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { openReportIssue } from "@/ui/components/report-issue-store";
import { Field } from "@/ui/preferences/fields";
import { closePreferences } from "@/ui/preferences/preferences-store";
import { settings, type PrefSection } from "@/ui/preferences/section-model";

export function AboutSection() {
  const native = window.safelightNative;
  const repo = "https://github.com/anthonyreimche/SafeLight";
  const rows: { label: string; value: string }[] = [
    { label: "Version", value: `v${__APP_VERSION__}` },
    ...(native
      ? [
          { label: "Electron", value: native.versions.electron },
          { label: "Chromium", value: native.versions.chrome },
          { label: "Platform", value: native.platform },
        ]
      : [{ label: "Environment", value: "Browser (dev)" }]),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-[15px] font-semibold tracking-wide text-text-primary">
          Safelight
        </div>
        <p className="mt-0.5 text-[11px] text-text-secondary">
          A fast RAW photo editor.
        </p>
        <p className="mt-1.5 text-[11px] text-text-primary">
          Safelight — founded and principally authored by Anthony Reimche
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
          Free software under the GNU GPL v3 (with a §7(b) attribution term).
          Includes third-party components under their own licenses. Product
          names and trademarks are the property of their respective owners.
        </p>
      </div>

      <table className="w-full text-[11px]">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-border-subtle">
              <td className="py-1 pr-3 text-text-muted">{r.label}</td>
              <td className="py-1 text-right font-medium text-text-primary tabular-nums">
                {r.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <Field label="Project">
        <a
          href={repo}
          target="_blank"
          rel="noreferrer"
          className="text-[11px] text-slider-fill hover:underline"
        >
          {repo.replace("https://", "")}
        </a>
      </Field>

      <Field label="Feedback" hint="Opens a GitHub issue with diagnostics you can check first.">
        <button
          type="button"
          onClick={() => {
            closePreferences();
            void openReportIssue();
          }}
          className="text-[11px] text-slider-fill hover:underline"
        >
          Report an issue…
        </button>
      </Field>

      <Field label="Legal">
        <div className="flex flex-col gap-0.5">
          {[
            ["License (GNU GPL v3)", "LICENSE"],
            ["Third-party notices", "THIRD-PARTY-NOTICES.md"],
            ["Privacy", "PRIVACY.md"],
            ["Trademarks", "TRADEMARKS.md"],
          ].map(([label, file]) => (
            <a
              key={file}
              href={`${repo}/blob/main/${file}`}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-slider-fill hover:underline"
            >
              {label}
            </a>
          ))}
        </div>
      </Field>

      <p className="text-[10px] leading-relaxed text-text-muted">
        © {new Date().getFullYear()} Anthony Reimche. Licensed under the GNU
        GPL v3 with an attribution-preservation term (§7b) — free to use,
        modify and redistribute; the founding-author credit above must be kept.
        See the LICENSE file for details.
      </p>
    </div>
  );
}

export const aboutSection: PrefSection = {
  id: "About",
  label: "About",
  group: "General",
  items: settings("Version", "Project"),
  keywords: ["Electron", "Chromium", "Platform", "license"],
  render: () => <AboutSection />,
};
