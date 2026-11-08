// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { WorkerLink } from "./transport";

// A render the worker hasn't answered in this long is given up on, so a reply that
// never comes can't hold the next render back for good. A worker drawing a heavy photo
// says nothing until each render is done, as one that stopped does, so once one of its
// last RENDER_TIMES_KEPT answers took longer, it gets SLOW_RENDER_ALLOWANCE times the
// slowest of them instead.
const RENDER_WATCHDOG_MS = 2_000;
const RENDER_TIMES_KEPT = 8;
const SLOW_RENDER_ALLOWANCE = 3;
// While a render given up on may still be answered, the one sent after it isn't timed:
// the worker may only be slow. One that says nothing at all for this long has stopped,
// or lost both answers, and gets the newest request anyway.
const RENDER_BACKSTOP_MS = 30_000;
// A worker the backstop gives up on this many times in a row, with no word from it in
// between, is taken to have hung. A software-rendered frame of a heavy photo takes
// seconds, so a minute of silence while renders wait is not one being drawn.
const SILENT_BACKSTOPS = 2;

/** What a render asks for besides the frame. */
export interface WaitingRender {
  wantHistogram: boolean;
  wantExtended: boolean;
}

/** The render mailbox: the seq of the one render the worker is drawing, and the newest
 *  request made since, which goes when that one is answered. The worker draws renders
 *  in the order they come, so posting each request while it is slower than the display
 *  queues a backlog the view plays back after the user lets go. */
export class RenderMailbox {
  private readonly link: WorkerLink;
  private seq = 0;
  private inFlight: number | null = null;
  // What the render in flight asked for besides the frame.
  private inFlightWants: WaitingRender | null = null;
  // When the render in flight started to be timed: its post, or `ready` for one posted
  // before it. null while it isn't timed.
  private since: number | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private waiting: WaitingRender | null = null;
  /** performance.now() of the last render requested, however it was queued. */
  lastRequestedAt = -Infinity;
  // The render last given up on while its answer may still come. The worker draws renders
  // in order, so until it answers that one or the one sent after it, another render sent
  // would only queue behind them.
  private overdue: { seq: number; since: number; wants: WaitingRender | null } | null = null;
  // The histogram a frame that put off prepasses asked for, when its render had been
  // given up on and no follow-up carried the want: the next render takes it on.
  private owed: WaitingRender | null = null;
  // How long, in ms, the worker took over each of its last answers.
  private times: number[] = [];
  private backstop: ReturnType<typeof setTimeout> | null = null;
  // When the backstop last sent a render. Not the worker speaking, so it times the
  // backstop alone and not the worker's other requests.
  private backstopSentAt = 0;
  // How many times in a row the backstop gave up with no word from the worker between.
  private silentBackstops = 0;
  private readonly onSilent: () => void;
  private readonly mayBeQuiet: () => boolean;

  /** `onSilent` is told when the worker has said nothing through SILENT_BACKSTOPS
   *  backstops in a row, none of them while `mayBeQuiet` (a long job it says nothing
   *  during). */
  constructor(link: WorkerLink, onSilent: () => void, mayBeQuiet: () => boolean) {
    this.link = link;
    this.onSilent = onSilent;
    this.mayBeQuiet = mayBeQuiet;
  }

  /** Draw a frame of the state the worker holds. While one is in flight only the
   *  newest request waits, asking for every histogram the requests it replaced asked
   *  for, and goes once the worker answers. */
  render(wantHistogram: boolean, wantExtended: boolean) {
    this.lastRequestedAt = performance.now();
    // Without its context the worker has nothing to draw with, nor a source once it is
    // restored: the view renders again when it hands the photo over.
    if (this.link.disposed || this.link.availability === "lost") return;
    if (this.inFlight === null) {
      this.post({ wantHistogram, wantExtended });
      return;
    }
    const waiting = this.waiting;
    this.waiting = {
      wantHistogram: wantHistogram || (waiting?.wantHistogram ?? false),
      wantExtended: wantExtended || (waiting?.wantExtended ?? false),
    };
  }

  /** Measure the worker's last render. While a render waits the measurement rides on
   *  it: sent on its own, the worker would measure the render in flight, and the newer
   *  one waiting would go unmeasured. */
  computeHistogram(wantExtended?: boolean) {
    const waiting = this.waiting;
    if (waiting) {
      this.waiting = {
        wantHistogram: true,
        wantExtended: waiting.wantExtended || !!wantExtended,
      };
      return;
    }
    this.link.post({ cmd: "computeHistogram", wantExtended });
  }

  /** The worker answered render `seq`. A frame that put off mask copies' prepasses
   *  is followed by a render of the same state, asking what it asked, unless a render
   *  already waits to be that one: what that render asks for is returned. The worker
   *  measures no histogram for the frame, so a waiting render takes over the one it
   *  asked for. */
  answered(seq: number, prepassPending = false): WaitingRender | null {
    const pending = prepassPending && seq === this.inFlight;
    const late = prepassPending && this.overdue?.seq === seq ? this.overdue.wants : null;
    if (late?.wantHistogram) this.owe(late);
    let again = pending && !this.waiting ? this.inFlightWants : null;
    const asked = this.inFlightWants;
    if (pending && this.waiting && asked?.wantHistogram) {
      this.waiting = {
        wantHistogram: true,
        wantExtended: this.waiting.wantExtended || asked.wantExtended,
      };
    }
    this.renderAnswered(seq);
    if (!again && this.owed && this.inFlight === null) again = this.owed;
    return again;
  }

  private owe(wants: WaitingRender) {
    this.owed = {
      wantHistogram: true,
      wantExtended: wants.wantExtended || (this.owed?.wantExtended ?? false),
    };
  }

  private post(asked: WaitingRender) {
    const owed = this.owed;
    this.owed = null;
    const request = owed
      ? { wantHistogram: true, wantExtended: asked.wantExtended || owed.wantExtended }
      : asked;
    const seq = ++this.seq;
    this.inFlight = seq;
    this.inFlightWants = request;
    this.since = null;
    this.armWatchdog();
    this.link.post({ cmd: "render", seq, ...request });
  }

  // Until `ready` the worker is creating its renderer and building the first program,
  // which can take longer than the watchdog allows, and draws nothing before that is
  // done. A render sent meanwhile holds the slot untimed and is timed from `ready`. One
  // sent while a render given up on may still be answered waits behind it in the worker,
  // so it is timed from its post, but only once that answer has come.
  armWatchdog() {
    const seq = this.inFlight;
    if (seq === null || this.watchdog || this.link.availability !== "ready") return;
    const now = performance.now();
    const since = (this.since ??= now);
    if (this.overdue) {
      this.armBackstop();
      return;
    }
    const giveUpMs = this.giveUpMs();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      console.warn(`[render-bridge] render ${seq} not answered in ${Math.round(giveUpMs)} ms`);
      this.overdue = { seq, since, wants: this.inFlightWants };
      this.sendWaiting();
    }, Math.max(0, since + giveUpMs - now));
  }

  // The render in flight, untimed behind one given up on, becomes the one given up on
  // once the worker has said nothing for RENDER_BACKSTOP_MS, and the newest request goes.
  private armBackstop() {
    if (this.backstop) return;
    const check = () => {
      const quiet = performance.now() - this.quietSince();
      if (quiet < RENDER_BACKSTOP_MS) {
        this.backstop = setTimeout(check, RENDER_BACKSTOP_MS - quiet);
        return;
      }
      this.backstop = null;
      const seq = this.inFlight;
      if (seq === null) return;
      console.warn(`[render-bridge] no word from the worker in ${RENDER_BACKSTOP_MS} ms`);
      if (this.mayBeQuiet()) this.silentBackstops = 0;
      else this.silentBackstops = this.link.heardAt > this.backstopSentAt ? 1 : this.silentBackstops + 1;
      this.backstopSentAt = performance.now();
      this.overdue = { seq, since: this.since ?? this.backstopSentAt, wants: this.inFlightWants };
      // Before the newest request goes, so it isn't timed while the worker is unresponsive.
      if (this.silentBackstops >= SILENT_BACKSTOPS) this.onSilent();
      this.sendWaiting();
    };
    const due = this.quietSince() + RENDER_BACKSTOP_MS - performance.now();
    this.backstop = setTimeout(check, Math.max(0, due));
  }

  // When the worker last said anything, or the backstop last sent a render.
  private quietSince(): number {
    return Math.max(this.link.heardAt, this.backstopSentAt);
  }

  private giveUpMs(): number {
    const slowest = Math.max(0, ...this.times);
    return slowest > RENDER_WATCHDOG_MS ? SLOW_RENDER_ALLOWANCE * slowest : RENDER_WATCHDOG_MS;
  }

  private noteTime(since: number) {
    this.times.push(performance.now() - since);
    if (this.times.length > RENDER_TIMES_KEPT) this.times.shift();
  }

  // A seq neither in flight nor overdue belongs to a render the mailbox cleared, so its
  // answer frees nothing. The worker answers renders in order: the answer to the one in
  // flight means the one given up on before it will never be answered.
  private renderAnswered(seq: number) {
    const overdue = this.overdue;
    if (overdue?.seq === seq) {
      this.noteTime(overdue.since);
      this.overdue = null;
      this.clearBackstop();
      this.armWatchdog();
      return;
    }
    if (seq !== this.inFlight) return;
    if (this.since !== null) this.noteTime(this.since);
    this.overdue = null;
    this.sendWaiting();
  }

  private sendWaiting() {
    const next = this.waiting;
    this.clearSlot();
    if (next) this.post(next);
  }

  private clearSlot() {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    this.clearBackstop();
    this.inFlight = null;
    this.since = null;
    this.waiting = null;
  }

  private clearBackstop() {
    if (this.backstop) clearTimeout(this.backstop);
    this.backstop = null;
  }

  // Seqs keep counting, so an answer to a render from before can't free a later one.
  clear() {
    this.clearSlot();
    this.overdue = null;
    this.owed = null;
    this.silentBackstops = 0;
  }
}
