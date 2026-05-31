import type { DevelopParams } from "@/catalog/types";

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
    };

const CHANNEL_NAME = "safelight-sync";

let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel {
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL_NAME);
  }
  return channel;
}

export function broadcast(message: BroadcastMessage): void {
  getChannel().postMessage(message);
}

export function onBroadcast(
  handler: (message: BroadcastMessage) => void,
): () => void {
  const ch = getChannel();
  const listener = (event: MessageEvent<BroadcastMessage>) => {
    handler(event.data);
  };
  ch.addEventListener("message", listener);
  return () => ch.removeEventListener("message", listener);
}
