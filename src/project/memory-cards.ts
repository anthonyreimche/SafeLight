// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The memory cards in the computer, for an ingest: asked of the main process
// (electron/memory-cards.cjs) every few seconds and when the window comes to
// the front, only while something shows them. Each card's folder is read-only.

import { useEffect, useSyncExternalStore } from "react";
import { nativeCardHandle, nativeFs } from "./native-fs";

export const CARD_POLL_MS = 3000;

export interface MemoryCard {
  /** New for each card put in, even in the same slot. */
  id: string;
  /** The volume's name, or its drive ("E:") on Windows. */
  name: string;
  /** Where it is mounted, to show the person. */
  path: string;
  /** The card's root folder. It lists and reads, and can't change the card. */
  folder: FileSystemDirectoryHandle;
}

const NONE: MemoryCard[] = [];

let cards: MemoryCard[] = NONE;
const listeners = new Set<() => void>();
let users = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let asking = false;
/** Whether a check has answered since polling started. */
let checked = false;

function sameList(next: { id: string; path: string }[]): boolean {
  return next.length === cards.length && next.every((c, i) => c.id === cards[i].id && c.path === cards[i].path);
}

async function poll(): Promise<void> {
  const list = nativeFs()?.listCards;
  if (!list || asking) return;
  asking = true;
  try {
    const found = await list();
    if (users === 0) return;
    const first = !checked;
    checked = true;
    if (sameList(found)) {
      if (first) for (const listener of listeners) listener();
      return;
    }
    const held = new Map(cards.map((c) => [`${c.id}\0${c.path}`, c]));
    cards = found.map(
      (c) => held.get(`${c.id}\0${c.path}`) ?? { id: c.id, name: c.name, path: c.path, folder: nativeCardHandle(c.path) },
    );
    for (const listener of listeners) listener();
  } catch {
    // Kept as it was; the next poll asks again.
  } finally {
    asking = false;
  }
}

const onFocus = () => void poll();

function start(): void {
  users++;
  if (users > 1 || !nativeFs()?.listCards) return;
  void poll();
  timer = setInterval(() => void poll(), CARD_POLL_MS);
  window.addEventListener("focus", onFocus);
}

function stop(): void {
  users--;
  if (users > 0) return;
  if (timer) clearInterval(timer);
  timer = null;
  window.removeEventListener("focus", onFocus);
  cards = NONE;
  checked = false;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Call `listener` with the memory cards in the computer: once when the first
 *  check answers (the cards already in, maybe none), then whenever they change
 *  (a card put in or taken out), until the function it returns is called. */
export function onMemoryCards(listener: (cards: MemoryCard[]) => void): () => void {
  const notify = () => listener(cards);
  listeners.add(notify);
  start();
  let subscribed = true;
  if (checked) queueMicrotask(() => subscribed && listener(cards));
  return () => {
    if (!subscribed) return;
    subscribed = false;
    listeners.delete(notify);
    stop();
  };
}

/** React hook: the memory cards in the computer now, each a mounted volume
 *  holding a DCIM folder, in drive or volume order. Empty in the browser build.
 *  The list keeps its identity while nothing changes. */
export function useMemoryCards(): MemoryCard[] {
  useEffect(() => {
    start();
    return stop;
  }, []);
  return useSyncExternalStore(subscribe, () => cards, () => NONE);
}
