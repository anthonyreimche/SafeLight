// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Extension stylesheets: keeps the document's CSS in step with the registry's
// `stylesheets` contributions. Each window runs its own extension host, so a
// detached module window picks these up with no extra plumbing.
//
// Sheets are constructed CSSStyleSheets in document.adoptedStyleSheets, which
// always cascade after the document's own sheets and are exempt from the CSP's
// style-src (CSSOM writes are never inline styles). Tailwind v4 keeps its
// utilities inside @layer, so an unlayered rule from one of these sheets beats
// any utility class without `!important`. Where adoptedStyleSheets is missing
// (jsdom) a <style> element per sheet, re-appended in order, does the same job.

import { useRegistry, type RegisteredStylesheet } from "./registry";

const ATTR = "data-sl-stylesheet";

interface Constructed {
  sheet: CSSStyleSheet;
  css: string | null;
}

const constructed = new WeakMap<Document, Map<string, Constructed>>();

function adopts(doc: Document): boolean {
  return (
    Array.isArray(doc.adoptedStyleSheets) &&
    typeof doc.defaultView?.CSSStyleSheet === "function"
  );
}

/** replaceSync refuses @import (and throws for it); the sheet is left empty
 *  rather than half-applied, and the author gets a console warning. */
function fill(entry: Constructed, id: string, css: string): void {
  entry.css = css;
  try {
    entry.sheet.replaceSync(css);
  } catch (e) {
    console.warn(`[stylesheets] ${id}: CSS rejected —`, e);
    entry.sheet.replaceSync("");
  }
}

function syncAdopted(ordered: RegisteredStylesheet[], doc: Document): void {
  let ours = constructed.get(doc);
  if (!ours) {
    ours = new Map();
    constructed.set(doc, ours);
  }
  const previous = new Set(Array.from(ours.values(), (e) => e.sheet));
  const live = new Set(ordered.map((s) => s.id));
  for (const id of Array.from(ours.keys())) if (!live.has(id)) ours.delete(id);

  const next: CSSStyleSheet[] = [];
  for (const { id, css } of ordered) {
    let entry = ours.get(id);
    if (!entry) {
      entry = { sheet: new doc.defaultView!.CSSStyleSheet(), css: null };
      ours.set(id, entry);
    }
    if (entry.css !== css) fill(entry, id, css);
    next.push(entry.sheet);
  }
  doc.adoptedStyleSheets = [
    ...doc.adoptedStyleSheets.filter((s) => !previous.has(s)),
    ...next,
  ];
}

function syncElements(ordered: RegisteredStylesheet[], doc: Document): void {
  const existing = new Map<string, HTMLStyleElement>();
  for (const el of doc.head.querySelectorAll<HTMLStyleElement>(`style[${ATTR}]`)) {
    existing.set(el.getAttribute(ATTR) ?? "", el);
  }
  const live = new Set(ordered.map((s) => s.id));
  for (const [id, el] of existing) if (!live.has(id)) el.remove();
  for (const { id, css } of ordered) {
    let el = existing.get(id);
    if (!el) {
      el = doc.createElement("style");
      el.setAttribute(ATTR, id);
    }
    if (el.textContent !== css) el.textContent = css;
    // Re-appending an element moves it, so registration order always holds and
    // extension sheets stay behind every stylesheet already in <head>.
    doc.head.appendChild(el);
  }
}

/** Make `doc` reflect exactly `sheets`, in registration order. Idempotent. */
export function syncStylesheets(
  sheets: Record<string, RegisteredStylesheet>,
  doc: Document = document,
): void {
  const ordered = Object.values(sheets);
  if (adopts(doc)) syncAdopted(ordered, doc);
  else syncElements(ordered, doc);
}

/** Apply the current registry and follow every later change. Returns the
 *  unsubscribe, for tests; the app keeps the subscription for its lifetime. */
export function initStylesheets(): () => void {
  syncStylesheets(useRegistry.getState().stylesheets);
  return useRegistry.subscribe((s, prev) => {
    if (s.stylesheets !== prev.stylesheets) syncStylesheets(s.stylesheets);
  });
}
