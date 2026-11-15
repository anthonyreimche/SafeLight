// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Latest-wins rendering for one view. One render is in flight at a time; while
// it runs, only the newest ask waits behind it, so a burst of changes renders
// once at the end. Asks for the same thing share one render.

export interface LatestWins<T> {
  /** The value for `key`: the last one rendered when it is that key's, else the render of it in
   *  flight or waiting, else `render` once nothing is in flight. Resolves null when a newer ask
   *  takes its place before it starts. */
  ask(key: string, render: () => Promise<T>): Promise<T | null>;
}

interface Waiter<T> { resolve(value: T | null): void; reject(error: unknown): void }
interface Job<T> { key: string; render: () => Promise<T>; waiters: Waiter<T>[] }

export function createLatestWins<T>(): LatestWins<T> {
  let running: Job<T> | null = null;
  let waiting: Job<T> | null = null;
  let kept: { key: string; value: T } | null = null;

  const start = (job: Job<T>): void => {
    running = job;
    void job.render()
      .then(
        (value) => {
          kept = { key: job.key, value };
          for (const w of job.waiters) w.resolve(value);
        },
        (error: unknown) => {
          for (const w of job.waiters) w.reject(error);
        },
      )
      .finally(() => {
        running = null;
        const next = waiting;
        waiting = null;
        if (next) start(next);
      });
  };

  return {
    ask(key, render) {
      if (kept?.key === key) return Promise.resolve(kept.value);
      return new Promise<T | null>((resolve, reject) => {
        const waiter = { resolve, reject };
        if (running?.key === key) running.waiters.push(waiter);
        else if (!running) start({ key, render, waiters: [waiter] });
        else if (waiting?.key === key) waiting.waiters.push(waiter);
        else {
          for (const w of waiting?.waiters ?? []) w.resolve(null);
          waiting = { key, render, waiters: [waiter] };
        }
      });
    },
  };
}
