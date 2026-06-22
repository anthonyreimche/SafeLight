// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Minimal, dependency-free Markdown renderer for extension READMEs fetched from
// GitHub. The README is UNTRUSTED, so unlike marked+innerHTML this never emits
// raw HTML: it parses a constrained Markdown subset into React elements, and
// React escapes every text node — there is no HTML/script injection path. URL
// schemes are allow-listed (http/https/mailto + repo-relative), so `javascript:`
// and `data:` links/images can't slip through. Any literal HTML in the source is
// rendered as plain text.
//
// Supported: ATX headings, fenced & indented code, unordered/ordered lists,
// blockquotes, horizontal rules, GFM pipe tables, paragraphs, and inline
// **bold**, *italic*, `code`, [links](url), and ![images](url).

import { Fragment, type ReactNode } from "react";
import { openUrl } from "@/update/update-checker";
import { resolveUrl } from "./markdown-url";

interface Props {
  source: string;
  /** "owner/repo" — resolves relative image/link targets to raw/blob URLs. */
  repo?: string;
  /** Branch the README was fetched from (for relative resolution). */
  branch?: string;
}

// ── Inline parsing ──────────────────────────────────────────────────────────

// Ordered so the first match wins at each scan position.
const INLINE = [
  { type: "code", re: /`([^`]+)`/y },
  { type: "image", re: /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/y },
  { type: "link", re: /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/y },
  { type: "bold", re: /\*\*([^*]+)\*\*|__([^_]+)__/y },
  { type: "italic", re: /\*([^*]+)\*|_([^_]+)_/y },
] as const;

function parseInline(
  text: string,
  repo?: string,
  branch?: string,
  keyBase = "i",
): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  let plain = "";
  let k = 0;
  const flush = () => {
    if (plain) {
      out.push(<Fragment key={`${keyBase}-t${k++}`}>{plain}</Fragment>);
      plain = "";
    }
  };
  while (i < text.length) {
    let matched = false;
    for (const rule of INLINE) {
      rule.re.lastIndex = i;
      const m = rule.re.exec(text);
      if (!m || m.index !== i) continue;
      // Capture the end NOW. Matches are anchored at i, so i + m[0].length is
      // exact — and immune to the recursive parseInline() calls below clobbering
      // the shared sticky regex's lastIndex (which would otherwise rewind i and
      // hang the whole renderer in an infinite loop).
      const next = i + m[0].length;
      flush();
      const key = `${keyBase}-${k++}`;
      if (rule.type === "code") {
        out.push(
          <code key={key} className="rounded bg-surface-2 px-1 py-px text-text-primary">
            {m[1]}
          </code>,
        );
      } else if (rule.type === "image") {
        const src = resolveUrl(m[2], "img", repo, branch);
        if (src)
          out.push(
            <img
              key={key}
              src={src}
              alt={m[1]}
              className="my-1 max-w-full rounded"
              loading="lazy"
            />,
          );
        else if (m[1]) plain += m[1];
      } else if (rule.type === "link") {
        const href = resolveUrl(m[2], "link", repo, branch);
        const inner = parseInline(m[1], repo, branch, key);
        if (href)
          out.push(
            <a
              key={key}
              href={href}
              onClick={(e) => {
                e.preventDefault();
                openUrl(href);
              }}
              className="text-text-primary underline decoration-text-muted underline-offset-2 hover:decoration-text-primary"
            >
              {inner}
            </a>,
          );
        else out.push(<Fragment key={key}>{inner}</Fragment>);
      } else if (rule.type === "bold") {
        out.push(
          <strong key={key} className="font-semibold text-text-primary">
            {parseInline(m[1] ?? m[2], repo, branch, key)}
          </strong>,
        );
      } else if (rule.type === "italic") {
        out.push(<em key={key}>{parseInline(m[1] ?? m[2], repo, branch, key)}</em>);
      }
      i = next;
      matched = true;
      break;
    }
    if (!matched) {
      plain += text[i];
      i++;
    }
  }
  flush();
  return out;
}

// ── Block parsing ───────────────────────────────────────────────────────────

function isTableSep(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** Render the whole document to a flat list of block elements. */
function renderBlocks(src: string, repo?: string, branch?: string): ReactNode[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let key = 0;
  const nextKey = () => `b${key++}`;

  for (let i = 0; i < lines.length; ) {
    const line = lines[i];

    // Blank line — skip.
    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code block.
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence
      blocks.push(
        <pre
          key={nextKey()}
          className="my-2 overflow-x-auto rounded bg-surface-2 p-2 text-[10px] leading-relaxed text-text-primary"
        >
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // ATX heading.
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const sizes = ["text-[15px]", "text-[14px]", "text-[13px]", "text-[12px]", "text-[11px]", "text-[11px]"];
      blocks.push(
        <div
          key={nextKey()}
          className={`mt-3 mb-1 font-semibold text-text-primary ${sizes[level - 1]} ${
            level <= 2 ? "border-b border-border-subtle pb-1" : ""
          }`}
        >
          {parseInline(heading[2].replace(/\s+#+\s*$/, ""), repo, branch, nextKey())}
        </div>,
      );
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={nextKey()} className="my-3 border-border-subtle" />);
      i++;
      continue;
    }

    // GFM table: header row + separator row.
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push(
        <div key={nextKey()} className="my-2 overflow-x-auto">
          <table className="w-full border-collapse text-[10px]">
            <thead>
              <tr>
                {header.map((c, ci) => (
                  <th
                    key={ci}
                    className="border border-border-subtle px-2 py-1 text-left font-semibold text-text-primary"
                  >
                    {parseInline(c, repo, branch, `${nextKey()}h${ci}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {header.map((_, ci) => (
                    <td key={ci} className="border border-border-subtle px-2 py-1 text-text-secondary">
                      {parseInline(r[ci] ?? "", repo, branch, `${nextKey()}r${ri}c${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Blockquote (consecutive > lines).
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote
          key={nextKey()}
          className="my-2 border-l-2 border-border pl-3 text-text-secondary"
        >
          {parseInline(body.join(" "), repo, branch, nextKey())}
        </blockquote>,
      );
      continue;
    }

    // Lists (unordered or ordered). One flat level — good enough for READMEs.
    const listItem = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (listItem) {
      const ordered = /\d/.test(listItem[2]);
      const items: ReactNode[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!m) break;
        items.push(
          <li key={nextKey()} className="ml-4 list-outside list-disc pl-1">
            {parseInline(m[3], repo, branch, nextKey())}
          </li>,
        );
        i++;
      }
      const cls = "my-2 flex flex-col gap-0.5 text-text-secondary";
      blocks.push(
        ordered ? (
          <ol key={nextKey()} className={`${cls} [&>li]:list-decimal`}>
            {items}
          </ol>
        ) : (
          <ul key={nextKey()} className={cls}>
            {items}
          </ul>
        ),
      );
      continue;
    }

    // Paragraph: gather until a blank line or a block-starting line.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(#{1,6}\s|>|```|~~~|[-*+]\s|\d+[.)]\s)/.test(lines[i])) {
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i])) break;
      para.push(lines[i]);
      i++;
    }
    if (para.length) {
      blocks.push(
        <p key={nextKey()} className="my-2 leading-relaxed text-text-secondary">
          {parseInline(para.join(" "), repo, branch, nextKey())}
        </p>,
      );
    } else {
      i++; // safety: never loop forever
    }
  }

  return blocks;
}

/** Render README markdown as themed, sanitized React elements. */
export function Markdown({ source, repo, branch }: Props) {
  return (
    <div className="text-[11px] text-text-secondary [&_a]:break-words">
      {renderBlocks(source, repo, branch)}
    </div>
  );
}
