// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { AppModule, DevelopParams } from "@/catalog/types";

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
      payload: { action: string; id?: string; origin?: string };
    }
  | {
      // A module window was popped out / re-attached, so the main window can
      // reflect it in the tab strip.
      type: "detach" | "attach";
      payload: { module: AppModule };
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
