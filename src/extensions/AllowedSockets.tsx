// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Permissions line of an extension that declares userSockets, on its page
// in the Extensions window: what the permission means and, once installed, the
// addresses the person allowed it (api.sockets), each with Disconnect. A
// change reaches the network policy at the next launch, as the allowing did.

import { useEffect, useState } from "react";
import { privilegedSockets } from "@/native/privileged";

export function AllowedSockets({ extensionId, installed }: { extensionId: string | undefined; installed: boolean }) {
  const [allowed, setAllowed] = useState<string[]>([]);
  const [revoked, setRevoked] = useState(false);

  useEffect(() => {
    if (!installed || !extensionId) return;
    let live = true;
    void privilegedSockets()
      ?.list(extensionId)
      .then((found) => {
        if (live) setAllowed(found.filter((o): o is string => typeof o === "string"));
      });
    return () => {
      live = false;
    };
  }, [extensionId, installed]);

  const disconnect = async (origin: string) => {
    if (!extensionId) return;
    await privilegedSockets()?.revoke(extensionId, origin);
    setAllowed((list) => list.filter((o) => o !== origin));
    setRevoked(true);
  };

  return (
    <div className="text-text-muted">
      Keeps live connections to a server address you enter. Safelight asks you before it allows each
      address, which works from the next launch.
      {allowed.map((origin) => (
        <div key={origin} className="flex items-center gap-2">
          <span className="text-text-primary">{origin}</span>
          <button
            onClick={() => void disconnect(origin)}
            className="rounded px-2 py-1 text-[10px] text-text-muted hover:text-label-red"
          >
            Disconnect
          </button>
        </div>
      ))}
      {revoked && <div>A disconnected address stops working the next time Safelight starts.</div>}
    </div>
  );
}
