// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { DevelopedPixels, WorkerResponse } from "../render-protocol";
import type { FloatFrame } from "../float-frame";
import type { SourceSample } from "../source-sample";
import type { WorkerLink } from "./transport";

// A request the worker hasn't answered is settled as a failure would be once the
// worker has said nothing for this long. Not timed from the post alone: a worker
// working through a queue of thumbnails answers each in turn, one that stopped doesn't.
const REQUEST_SILENCE_MS = 30_000;
// The longest a long request (expect) holds the silence off for. A worker that
// hangs during one still gives way: past it, silence counts for every request again.
const LONG_REQUEST_MS = 5 * 60_000;

/** What a thumbnail request is answered with: its blob, or its frame as floats. */
export type ThumbAnswer = Extract<WorkerResponse, { type: "thumbnail" | "thumbnailFloat" }>;

type Pending<K, T> = Map<K, (value: T) => void>;

/** What the worker answers a capture it can't draw with. */
export function blankBitmap(): ImageBitmap {
  return new OffscreenCanvas(1, 1).transferToImageBitmap();
}

/** Settles every request in `pending` with its own `none()`, emptying it first so a
 *  settled request can't be settled again. */
function settleAll<K, T>(pending: Pending<K, T>, none: () => T) {
  const waiting = [...pending.values()];
  pending.clear();
  for (const settle of waiting) settle(none());
}

/** The requests waiting for the worker's answer, by kind. */
export class RenderRequests {
  private readonly link: WorkerLink;
  // Settled with the request's answer, or with null when the worker reports a cache
  // miss (the caller then decodes + uploads + retries) or a failure.
  readonly thumbs: Pending<string, ThumbAnswer | null> = new Map();
  readonly pixels: Pending<number, DevelopedPixels | null> = new Map();
  readonly sourceBound: Pending<number, boolean> = new Map();
  readonly hasSource: Pending<number, boolean> = new Map();
  readonly captures: Pending<number, ImageBitmap> = new Map();
  readonly floatCaptures: Pending<number, FloatFrame | null> = new Map();
  readonly sourceSamples: Pending<number, SourceSample | null> = new Map();
  readonly probes: Pending<number, [number, number, number] | null> = new Map();
  private idSeq = 0;
  // When each long request still waiting was posted, oldest first.
  private longPosted: number[] = [];

  constructor(link: WorkerLink) {
    this.link = link;
  }

  /** Whether a long request has run for less than LONG_REQUEST_MS: the worker may say
   *  nothing until it is done. */
  get longRunning(): boolean {
    const oldest = this.longPosted[0];
    return oldest !== undefined && performance.now() - oldest < LONG_REQUEST_MS;
  }

  nextId(): number {
    return ++this.idSeq;
  }

  // Waits for the worker's answer to request `id`, or settles it with `none` once the
  // worker has said nothing for REQUEST_SILENCE_MS, and at once when the bridge is
  // disposed or has failed. A `long` request, such as a full-view float read on a
  // software renderer, is one job the worker says nothing during, and answers the
  // requests queued behind it after: so while one has run for less than
  // LONG_REQUEST_MS, silence counts for no request.
  expect<K, T>(
    pending: Pending<K, T>,
    id: K,
    resolve: (value: NoInfer<T>) => void,
    none: () => NoInfer<T>,
    { long = false }: { long?: boolean } = {},
  ) {
    if (this.link.disposed || this.link.availability === "failed") {
      resolve(none());
      return;
    }
    const posted = performance.now();
    if (long) this.longPosted.push(posted);
    const check = () => {
      const quiet = this.longRunning ? 0 : performance.now() - this.link.heardAt;
      if (quiet < REQUEST_SILENCE_MS) {
        timer = setTimeout(check, REQUEST_SILENCE_MS - quiet);
        return;
      }
      if (pending.get(id) !== settle) return;
      pending.delete(id);
      settle(none());
    };
    let timer = setTimeout(check, REQUEST_SILENCE_MS);
    const settle = (value: T) => {
      clearTimeout(timer);
      if (long) this.longPosted.splice(this.longPosted.indexOf(posted), 1);
      resolve(value);
    };
    pending.set(id, settle);
  }

  /** Settles request `id` with the worker's answer, once; false when nothing waits
   *  for it (given up on, or never asked). */
  answer<K, T>(pending: Pending<K, T>, id: K, value: NoInfer<T>): boolean {
    const settle = pending.get(id);
    if (!settle) return false;
    pending.delete(id);
    settle(value);
    return true;
  }

  settleAll() {
    settleAll(this.thumbs, () => null);
    settleAll(this.pixels, () => null);
    settleAll(this.sourceBound, () => false);
    settleAll(this.hasSource, () => false);
    settleAll(this.captures, blankBitmap);
    settleAll(this.floatCaptures, () => null);
    settleAll(this.sourceSamples, () => null);
    settleAll(this.probes, () => null);
  }
}
