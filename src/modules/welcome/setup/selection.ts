// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Which starter-kit extensions are on offer and which are picked. Picks are a
// set of repos rather than of kits: kits overlap, an extension picked through
// one kit is picked everywhere it appears, and a kit's tick is derived from
// its extensions. Installed extensions are never picked and never counted.

import { bannedReasonIn, isVerifiedIn } from "@/extensions/trust";
import type { TrustList } from "@/extensions/types";
import type { KitExtension, StarterKit } from "./kits";

export type KitState = "off" | "on" | "mixed" | "installed";

/** Kits narrowed to what may be installed now: on the verified list and not
 *  banned. The trust list can change after kits.json was published. */
export function visibleKits(
  kits: readonly StarterKit[],
  trust: TrustList,
): StarterKit[] {
  return kits.flatMap((kit) => {
    const extensions = kit.extensions.filter(
      (e) => isVerifiedIn(trust, e.repo) && !bannedReasonIn(trust, e.repo),
    );
    return extensions.length > 0 ? [{ ...kit, extensions }] : [];
  });
}

const notInstalled = (kit: StarterKit, installed: ReadonlySet<string>) =>
  kit.extensions.filter((e) => !installed.has(e.repo));

export function kitState(
  kit: StarterKit,
  selected: ReadonlySet<string>,
  installed: ReadonlySet<string>,
): KitState {
  const open = notInstalled(kit, installed);
  if (open.length === 0) return "installed";
  const picked = open.filter((e) => selected.has(e.repo)).length;
  if (picked === 0) return "off";
  return picked === open.length ? "on" : "mixed";
}

/** Ticking a kit picks everything in it that isn't installed; unticking an
 *  "on" kit clears its extensions, including any shared with other kits. */
export function toggleKit(
  kit: StarterKit,
  selected: ReadonlySet<string>,
  installed: ReadonlySet<string>,
): Set<string> {
  const next = new Set(selected);
  const on = kitState(kit, selected, installed) === "on";
  for (const e of notInstalled(kit, installed)) {
    if (on) next.delete(e.repo);
    else next.add(e.repo);
  }
  return next;
}

export function toggleExtension(
  repo: string,
  selected: ReadonlySet<string>,
): Set<string> {
  const key = repo.toLowerCase();
  const next = new Set(selected);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** The extensions to install, once each, in the order the kits list them. */
export function pendingInstalls(
  kits: readonly StarterKit[],
  selected: ReadonlySet<string>,
  installed: ReadonlySet<string>,
): KitExtension[] {
  const seen = new Set<string>();
  const out: KitExtension[] = [];
  for (const kit of kits)
    for (const e of kit.extensions) {
      if (!selected.has(e.repo) || installed.has(e.repo) || seen.has(e.repo))
        continue;
      seen.add(e.repo);
      out.push(e);
    }
  return out;
}
