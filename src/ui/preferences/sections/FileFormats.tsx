// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useLayoutEffect, useRef } from "react";
import {
  chainSignature,
  decoderChain,
  DECODER_FORMATS,
  isExtensionEntry,
  keepingAbsent,
  useDecoders,
  withDecoderOrder,
  type DecoderFormat,
} from "@/catalog/image-decoders";
import { rebuildFormatPreviews } from "@/modules/library/format-rebuild";
import { getExtensionName } from "@/extensions/param-registry";
import { getSettings, updateSettings, useSettings } from "@/state/settings-store";
import { btnCls, Field, labelCls } from "@/ui/preferences/fields";
import { settings, type PrefSection } from "@/ui/preferences/section-model";

type Direction = "up" | "down";

interface FocusTarget {
  decoderId: string;
  direction: Direction;
}

const STANDARD_FORMATS = DECODER_FORMATS.filter((format) => !format.raw);
const RAW_FORMATS = DECODER_FORMATS.filter((format) => format.raw);

/** Save `order` for `format`, and rebuild its grid previews if that changed
 *  what it decodes with. Compared here, not on a subscription: an extension
 *  registering at launch changes a signature too, and rebuilds nothing. */
function saveOrder(format: DecoderFormat, ids: readonly string[] | null): void {
  const before = chainSignature(format.id);
  updateSettings({ decoderOrder: withDecoderOrder(getSettings().decoderOrder, format.id, ids) });
  if (chainSignature(format.id) !== before) rebuildFormatPreviews(format.id);
}

function FormatRow({ format }: { format: DecoderFormat }) {
  const saved = useSettings((s) => s.decoderOrder[format.id] !== undefined);
  const chain = decoderChain(format.id);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<FocusTarget | null>(null);

  // A button disabled by the move loses focus, so focus goes to its twin.
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    const wanted = buttons.current.get(`${target.decoderId}:${target.direction}`);
    const other = buttons.current.get(`${target.decoderId}:${target.direction === "up" ? "down" : "up"}`);
    (wanted && !wanted.disabled ? wanted : other)?.focus();
  });

  const move = (index: number, direction: Direction) => {
    const target = direction === "up" ? index - 1 : index + 1;
    const moved = chain[index];
    const displaced = chain[target];
    if (!moved || !displaced) return;
    const ids = chain.map((entry) => (entry === moved ? displaced.id : entry === displaced ? moved.id : entry.id));
    pendingFocus.current = { decoderId: moved.id, direction };
    saveOrder(format, keepingAbsent(format.id, ids));
  };

  return (
    <Field label={format.label}>
      <div role="group" aria-label={format.label} className="flex flex-col gap-1.5">
        <span className="text-[10px] text-text-muted">{format.extensions.join(" ")}</span>
        <ol className="flex flex-col gap-1">
          {chain.map((entry, index) => (
            <li
              key={entry.id}
              className="flex items-center gap-1.5 rounded bg-surface-2 px-2 py-1 text-[11px] text-text-primary"
            >
              <span className="min-w-0 flex-1 truncate">
                {entry.label}
                {isExtensionEntry(entry) && (
                  <span className="ml-1.5 text-[10px] text-text-muted">{getExtensionName(entry.owner)}</span>
                )}
              </span>
              {chain.length > 1 && index === 0 && (
                <span className="text-[10px] text-text-muted">Tried first</span>
              )}
              {chain.length > 1 && (
                <>
                  <button
                    ref={(node) => {
                      if (node) buttons.current.set(`${entry.id}:up`, node);
                      else buttons.current.delete(`${entry.id}:up`);
                    }}
                    onClick={() => move(index, "up")}
                    disabled={index === 0}
                    aria-label={`Move ${entry.label} up in ${format.label}`}
                    className={btnCls}
                  >
                    ↑
                  </button>
                  <button
                    ref={(node) => {
                      if (node) buttons.current.set(`${entry.id}:down`, node);
                      else buttons.current.delete(`${entry.id}:down`);
                    }}
                    onClick={() => move(index, "down")}
                    disabled={index === chain.length - 1}
                    aria-label={`Move ${entry.label} down in ${format.label}`}
                    className={btnCls}
                  >
                    ↓
                  </button>
                </>
              )}
            </li>
          ))}
        </ol>
        {chain.length > 1 && saved && (
          <div>
            <button
              onClick={() => saveOrder(format, null)}
              aria-label={`Reset ${format.label} order`}
              className={btnCls}
            >
              Reset
            </button>
          </div>
        )}
      </div>
    </Field>
  );
}

function FileFormatsSection() {
  useDecoders();
  const claimedRaw = RAW_FORMATS.filter((format) => decoderChain(format.id).length > 1);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[10px] leading-relaxed text-text-muted">
        Each format is read by its decoders, tried from the top down: a decoder that can't read a
        file passes it to the next.
      </p>
      {STANDARD_FORMATS.map((format) => (
        <FormatRow key={format.id} format={format} />
      ))}
      {claimedRaw.length > 0 && (
        <>
          <div className="border-t border-border-subtle pt-3">
            <div className={labelCls}>RAW</div>
          </div>
          {claimedRaw.map((format) => (
            <FormatRow key={format.id} format={format} />
          ))}
          <p className="text-[10px] leading-relaxed text-text-muted">
            The other RAW formats use the built-in decoder.
          </p>
        </>
      )}
    </div>
  );
}

export const fileFormatsSection: PrefSection = {
  id: "File formats",
  label: "File formats",
  group: "General",
  items: settings(...STANDARD_FORMATS.map((format) => format.label), "RAW"),
  keywords: ["decoder", "decoders", "priority", "order", "heic", "heif", "extension decoder", "codec"],
  render: () => <FileFormatsSection />,
};
