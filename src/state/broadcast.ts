// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { AppModule, DevelopParams, EditState, StoredPhoto } from "@/catalog/types";
import type { ChangeStamps } from "@/project/change-stamps";

/** What one catalog write stored: edit histories, photo records as catalog.json
 *  holds them, and the ids of photos removed from the catalog. */
export interface CatalogRecords {
  edits: EditState[];
  photos: StoredPhoto[];
  deletedIds: string[];
}

/** Catalog records as a window's ProjectStorage sends them to the others. */
export interface SentCatalogRecords extends CatalogRecords {
  /** The catalog file they belong to (see catalogKey in project-storage). */
  catalog: string;
  /** The sending storage, not just its window. */
  origin: string;
  /** When the records entered the sender's copy (Date.now()): any save of it
   *  that began later holds them. */
  since: number;
  /** Set, with no records, by a sender whose window left the catalog and whose
   *  writes kept failing: what it sent from `since` on may be in no file, so each
   *  window that holds all of it saves: one listening from before then, or one
   *  that had the sender's answer. */
  unsaved?: true;
  /** The change stamps of these records (see project/change-stamps). */
  changed?: ChangeStamps;
  /** Set on a storage's answer to another's hello: every record it changed or took
   *  in since it opened, its removals, and the files it removed (`removed`). */
  answer?: true;
  /** In an answer: the files removed from the catalog in the sender's session that
   *  are still on disk, so a window opening now doesn't import them again. */
  removed?: string[];
  /** In an answer: the storage whose hello it answers, the only one that takes it. */
  to?: string;
}

/** A storage that has just read catalog.json, asking the others on it for the
 *  changes the file may not hold yet. `since` is when it began listening: what the
 *  others wrote before then is in the file it read. */
export interface CatalogHello {
  catalog: string;
  origin: string;
  since: number;
}

export type BroadcastMessage =
  | {
      type: "selection-change";
      payload: { activePhotoId: string };
    }
  | {
      type: "edit-update";
      payload: { photoId: string | null; params: DevelopParams };
    }
  | {
      type: "catalog-change";
      // `origin` is the WINDOW_ID of the window that made the change, so a window
      // can ignore the local echo of its own broadcast (it already applied it).
      // An "update" with an `id` says that photo's preview was rewritten, so the
      // other windows reload it: send it for nothing else.
      payload: { action: string; id?: string; origin: string };
    }
  | {
      // A module window was popped out / re-attached, so the main window can
      // reflect it in the tab strip.
      type: "detach" | "attach";
      payload: { module: AppModule };
    }
  | {
      // A pop-out's navigation.goTo for a module other than its own, carried
      // out by the main window.
      type: "navigate";
      payload: { module: AppModule };
    }
  | {
      // Records a window's ProjectStorage just wrote. Each window saves the whole
      // catalog from its own copy, so the others take these on before their next
      // save.
      type: "catalog-records";
      payload: SentCatalogRecords;
    }
  | {
      // A window's ProjectStorage has read catalog.json: each other storage on the
      // catalog answers with the changes it holds (catalog-records, answer).
      type: "catalog-hello";
      payload: CatalogHello;
    };

const CHANNEL_NAME = "safelight-sync";

// Unique per browser context (main window, each detached window). Stamped onto
// broadcasts so a window can distinguish its own locally-echoed message from one
// that arrived over the channel from another window.
export const WINDOW_ID = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel {
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL_NAME);
  }
  return channel;
}

// Same-window subscribers. BroadcastChannel deliberately does NOT echo a message
// back to the context that posted it, so without this the window that makes an
// edit never hears its own `edit-update` — leaving the Library's edited-thumbnail
// refresh to a 1s poll. We fan out locally too so same-window listeners react at
// once. Handlers must not synchronously re-broadcast the same message type.
const localListeners = new Set<(message: BroadcastMessage) => void>();

export function broadcast(message: BroadcastMessage): void {
  getChannel().postMessage(message);
  for (const l of [...localListeners]) l(message);
}

export function onBroadcast(
  handler: (message: BroadcastMessage) => void,
): () => void {
  const ch = getChannel();
  const listener = (event: MessageEvent<BroadcastMessage>) => {
    handler(event.data);
  };
  ch.addEventListener("message", listener);
  localListeners.add(handler);
  return () => {
    ch.removeEventListener("message", listener);
    localListeners.delete(handler);
  };
}
