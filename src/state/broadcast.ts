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
      payload: { action: string; id?: string };
    }
  | {
      // A module window was popped out / re-attached, so the main window can
      // reflect it in the tab strip.
      type: "detach" | "attach";
      payload: { module: AppModule };
    };

const CHANNEL_NAME = "safelight-sync";

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
