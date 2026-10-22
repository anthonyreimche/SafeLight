// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Report an issue: the user writes a title and what happened; everything
// Anthony needs to reproduce it (versions, graphics, extensions, the open
// photo, recent errors) is already filled in below, as editable text the user
// can check, change, clear or leave out. Nothing is sent from here: Open on
// GitHub opens the browser on a prefilled new issue, and Copy report covers
// people without a GitHub account.

import { useEffect, useId, useMemo, useState } from "react";
import { ModalWindow } from "@/ui/components/ModalWindow";
import { Button, TextArea, TextInput } from "@/extensions/ui-kit";
import { labelCls } from "@/extensions/SettingsFieldList";
import { setShortcutsSuspended, shortcutsSuspended } from "@/state/keybindings-store";
import { openUrl } from "@/update/update-checker";
import { collectReportSections, reportRedactor } from "@/diagnostics/collect";
import { readAppVersion } from "@/diagnostics/environment";
import { clearErrorLog } from "@/diagnostics/error-log";
import {
  MAX_TITLE,
  SECURITY_URL,
  fitReportToUrl,
  renderCopyText,
  type FittedReport,
  type ReportInput,
  type ReportSection,
  type SectionId,
} from "@/diagnostics/report-markdown";
import {
  clearReportDraft,
  closeReportIssue,
  openIssue,
  setReportDraft,
  useReportIssue,
} from "./report-issue-store";

const CONTACT_EMAIL = "anthonyreimche@gmail.com";
const BOX =
  "flex max-h-[90vh] w-[680px] max-w-[94vw] flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-2xl";

const pasteKey = (): string => (window.safelightNative?.platform === "darwin" ? "⌘V" : "Ctrl+V");

async function copyImage(png: Blob): Promise<boolean> {
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    return true;
  } catch {
    return false;
  }
}

function fitNote(fitted: FittedReport, sections: readonly ReportSection[]): string | null {
  if (!fitted.fits) return "Too long for a link: shorten the description, or use Copy report.";
  const parts: string[] = [];
  if (fitted.omittedEntries) parts.push(`leaves out the ${fitted.omittedEntries} oldest errors`);
  if (fitted.cutSections.length) {
    const labels = fitted.cutSections.map((id) => sections.find((s) => s.id === id)?.label ?? id);
    parts.push(`shortens ${labels.join(", ")}`);
  }
  if (fitted.cutDescription) parts.push("cuts the end of your description");
  return parts.length ? `The link ${parts.join(" and ")}. Copy report has everything.` : null;
}

export function ReportIssueDialog() {
  const open = useReportIssue((s) => s.open);
  return open ? <ReportIssueWindow /> : null;
}

function ReportIssueWindow() {
  const prefill = useReportIssue((s) => s.prefill);
  const screenshot = useReportIssue((s) => s.screenshot);
  const draft = useReportIssue((s) => s.draft);
  const [sections, setSections] = useState<ReportSection[] | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<SectionId>>(new Set());
  const [edited, setEdited] = useState<ReadonlySet<SectionId>>(new Set());
  const [attach, setAttach] = useState(false);
  const [appVersion, setAppVersion] = useState(__APP_VERSION__);
  const [status, setStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const titleId = useId();
  const descriptionId = useId();
  const includedId = useId();

  // A crash title comes from the error message, which can hold a path.
  useEffect(() => {
    if (prefill?.title) setReportDraft({ title: reportRedactor()(prefill.title) });
  }, [prefill]);

  useEffect(() => {
    let live = true;
    collectReportSections(prefill).then(
      (s) => live && setSections(s),
      (e: unknown) => {
        if (!live) return;
        setSections([]);
        setStatus(`Couldn't collect the diagnostics (${e instanceof Error ? e.message : String(e)}). You can still describe the problem.`);
      },
    );
    void readAppVersion().then((v) => live && setAppVersion(v));
    return () => {
      live = false;
    };
  }, [prefill]);

  // Typing here must not reach the app's shortcuts (Ctrl+Z would undo the edit
  // behind the dialog), and with them paused the shared Esc stack is too.
  useEffect(() => {
    const prev = shortcutsSuspended();
    setShortcutsSuspended(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeReportIssue();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      setShortcutsSuspended(prev);
    };
  }, []);

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!screenshot) return;
    const url = URL.createObjectURL(screenshot);
    setPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setPreviewUrl(null);
    };
  }, [screenshot]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const input: ReportInput = useMemo(
    () => ({
      title: draft.title.trim(),
      description: draft.description,
      sections: sections ?? [],
      appVersion,
      screenshot: attach && screenshot !== null,
      pasteKey: pasteKey(),
    }),
    [draft, sections, appVersion, attach, screenshot],
  );
  const fitted = useMemo(() => fitReportToUrl(input), [input]);
  const note = sections ? fitNote(fitted, sections) : null;
  const ready = sections !== null && draft.title.trim() !== "" && draft.description.trim() !== "";

  const updateSection = (id: SectionId, patch: Partial<ReportSection>) =>
    setSections((list) => list && list.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const editText = (id: SectionId, text: string) => {
    updateSection(id, { text });
    setEdited((set) => new Set(set).add(id));
  };
  const toggleExpanded = (id: SectionId) =>
    setExpanded((set) => {
      const next = new Set(set);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const send = async () => {
    setSending(true);
    setStatus(null);
    const wantsShot = attach && screenshot !== null;
    const shotCopied = wantsShot && (await copyImage(screenshot));
    const confirmed = await openIssue({ ...input, screenshot: shotCopied });
    if (!confirmed) {
      setStatus(
        "Safelight couldn't confirm that your browser opened. If no GitHub page appeared, use Copy report and paste it into a new issue on GitHub.",
      );
      setSending(false);
      return;
    }
    if (wantsShot && !shotCopied) {
      setStatus("Couldn't copy the screenshot. GitHub opened without it: use Copy image, then paste it into the issue.");
      setSending(false);
      return;
    }
    closeReportIssue();
    clearReportDraft();
  };

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(renderCopyText(input));
      setCopied(true);
    } catch {
      setStatus("Couldn't copy to the clipboard.");
    }
  };

  const copyScreenshot = async () => {
    if (screenshot && !(await copyImage(screenshot))) setStatus("Couldn't copy the screenshot.");
  };

  return (
    <ModalWindow title="Report an issue" onClose={closeReportIssue} boxClassName={BOX}>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div className="space-y-1">
          <label htmlFor={titleId} className={labelCls}>
            Title
          </label>
          <TextInput
            id={titleId}
            autoFocus
            maxLength={MAX_TITLE}
            value={draft.title}
            onChange={(title) => setReportDraft({ title })}
            placeholder="A short summary, e.g. Sliders stop responding after an export"
            spellCheck
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={descriptionId} className={labelCls}>
            What happened?
          </label>
          <TextArea
            id={descriptionId}
            rows={6}
            value={draft.description}
            onChange={(description) => setReportDraft({ description })}
            placeholder="What happened, and what were you doing just before? If you can make it happen again, list the steps."
            spellCheck
          />
        </div>

        {screenshot && (
          <div className="space-y-2">
            <label className="flex cursor-pointer items-center gap-2 text-[11px] text-text-primary">
              <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} />
              Attach a screenshot of the window
            </label>
            {attach && previewUrl && (
              <div className="flex items-start gap-3">
                <img
                  src={previewUrl}
                  alt="Screenshot of the window"
                  className="max-h-32 max-w-[45%] rounded border border-border"
                />
                <div className="space-y-2 text-[10px] leading-relaxed text-text-muted">
                  <p>
                    It shows everything in this window, including your photo. Open on GitHub copies it
                    to your clipboard, replacing what is there; press {pasteKey()} in the issue to
                    attach it.
                  </p>
                  <Button size="sm" onClick={() => void copyScreenshot()}>
                    Copy image
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        <section aria-labelledby={includedId} className="space-y-1.5">
          <h3 id={includedId} className={labelCls}>
            Included with your report
          </h3>
          {sections === null ? (
            <p className="text-[11px] text-text-muted">Collecting…</p>
          ) : (
            sections.map((s) => (
              <SectionRow
                key={s.id}
                section={s}
                expanded={expanded.has(s.id)}
                edited={edited.has(s.id)}
                onInclude={(include) => updateSection(s.id, { include })}
                onToggle={() => toggleExpanded(s.id)}
                onText={(text) => editText(s.id, text)}
                onDeleteLog={() => {
                  clearErrorLog();
                  editText(s.id, "");
                }}
              />
            ))
          )}
          <p className="text-[10px] leading-relaxed text-text-muted">
            GPS positions and serial numbers are never included, and folder names and photo file
            names are hidden wherever Safelight recognises them. Check the text anyway: what you see
            is exactly what goes into the issue, and issues are public.
          </p>
        </section>
      </div>

      <div className="shrink-0 space-y-2 border-t border-border bg-surface-2 px-4 py-3">
        <p className="text-[10px] leading-relaxed text-text-muted">
          Nothing is sent from Safelight. GitHub opens in your browser with this filled in, and you
          can still change it there before you submit. No GitHub account? Copy the report and email
          it to <span className="select-text text-text-secondary">{CONTACT_EMAIL}</span>.
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => openUrl(SECURITY_URL)}
            className="shrink-0 text-[10px] text-text-muted underline hover:text-text-primary"
          >
            Security problem? Report it privately
          </button>
          {note && <span className="ml-auto text-right text-[10px] text-text-muted">{note}</span>}
        </div>
        <div className="flex items-center justify-end gap-2">
          {status && (
            <span role="status" className="mr-auto text-[10px] text-text-secondary">
              {status}
            </span>
          )}
          <Button disabled={!ready} onClick={() => void copyReport()}>
            {copied ? "Copied" : "Copy report"}
          </Button>
          <Button variant="primary" disabled={!ready || !fitted.fits || sending} onClick={() => void send()}>
            Open on GitHub
          </Button>
        </div>
      </div>
    </ModalWindow>
  );
}

interface SectionRowProps {
  section: ReportSection;
  expanded: boolean;
  edited: boolean;
  onInclude: (include: boolean) => void;
  onToggle: () => void;
  onText: (text: string) => void;
  onDeleteLog: () => void;
}

function SectionRow({ section, expanded, edited, onInclude, onToggle, onText, onDeleteLog }: SectionRowProps) {
  const bodyId = useId();
  return (
    <div className="rounded border border-border-subtle">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-[11px]">
          <input
            type="checkbox"
            checked={section.include}
            aria-label={`Include ${section.label}`}
            onChange={(e) => onInclude(e.target.checked)}
          />
          <span className="shrink-0 text-text-primary">{section.label}</span>
          <span className="min-w-0 truncate text-text-muted">{edited ? "edited" : section.summary}</span>
        </label>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={`${expanded ? "Hide" : "Show"} ${section.label}`}
          onClick={onToggle}
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-text-muted hover:bg-surface-3 hover:text-text-primary"
        >
          {expanded ? "Hide" : "Show"}
        </button>
      </div>
      {expanded && (
        <div id={bodyId} className="space-y-1.5 border-t border-border-subtle p-2">
          <TextArea
            mono
            rows={8}
            value={section.text}
            onChange={onText}
            aria-label={`${section.label} text`}
          />
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" aria-label={`Clear ${section.label}`} onClick={() => onText("")}>
              Clear
            </Button>
            {section.id === "errors" && (
              <Button size="sm" variant="ghost" onClick={onDeleteLog}>
                Delete saved log
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
