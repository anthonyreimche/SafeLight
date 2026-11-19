// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Permissions line of an extension that declares programs, on its page in
// the Extensions window: what the permission means and, once installed, the
// programs the person allowed it to run (api.programs), each with Forget.

import { useEffect, useState } from "react";
import { privilegedPrograms } from "@/native/privileged";
import type { KeptProgram } from "./api/programs";

const isKept = (value: unknown): value is KeptProgram => {
  if (!value || typeof value !== "object") return false;
  const { token, path } = value as Record<string, unknown>;
  return typeof token === "string" && typeof path === "string";
};

export function AllowedPrograms({ extensionId, installed }: { extensionId: string | undefined; installed: boolean }) {
  const [allowed, setAllowed] = useState<KeptProgram[]>([]);

  useEffect(() => {
    if (!installed || !extensionId) return;
    let live = true;
    void privilegedPrograms()
      ?.list(extensionId)
      .then((found) => {
        if (live) setAllowed(found.filter(isKept));
      });
    return () => {
      live = false;
    };
  }, [extensionId, installed]);

  const forget = async (token: string) => {
    if (!extensionId) return;
    await privilegedPrograms()?.forget(extensionId, token);
    setAllowed((list) => list.filter((p) => p.token !== token));
  };

  return (
    <div className="text-text-muted">
      Runs a program on this computer that you choose. Safelight asks you before it allows each program.
      {allowed.map((program) => (
        <div key={program.token} className="flex items-center gap-2">
          <span className="text-text-primary">{program.path}</span>
          <button
            onClick={() => void forget(program.token)}
            className="rounded px-2 py-1 text-[10px] text-text-muted hover:text-label-red"
          >
            Forget
          </button>
        </div>
      ))}
    </div>
  );
}
