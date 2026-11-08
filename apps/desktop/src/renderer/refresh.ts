/**
 * @fileoverview The schedule of one workspace's charts. Each source a chart
 * refreshes on a schedule is checked at the shortest interval among its
 * charts, an interval after its last check ended. Due times are wall-clock
 * times and nothing pauses while the window is hidden, so a check that came
 * due while the machine slept runs once on wake, not once per interval missed.
 *
 * This file is plain logic, so tests run it directly.
 */

/** What a scheduled check of a source did. */
export type Refreshed =
  /** The source is as it was read, so nothing was read again. */
  | { t: "same" }
  /** The source changed, and its newer data was read. */
  | { t: "read" }
  /** The source changed, and `edits` cell edits hold its newer data back for
   * a refresh by hand. */
  | { t: "held"; edits: number }
  /** The source cannot be checked until ready() says so: it is indexing,
   * waits on its bucket, or has no file to read again. */
  | { t: "waiting"; why: "indexing" | "unconnected" | "nothing" };

/** A chart's schedule: its source, checked every `everyMs`. */
export interface Due {
  source: string;
  everyMs: number;
}

/** Checks a workspace's scheduled sources on time, with one timer. */
export class Refresher {
  private readonly run: (source: string) => Promise<Refreshed>;
  /** The shortest interval among each scheduled source's charts. */
  private readonly every = new Map<string, number>();
  /** When each source's last check ended, in ms since 1970. One not here is due now. */
  private readonly checked = new Map<string, number>();
  /** The sources with a check out. */
  private readonly running = new Set<string>();
  /** The sources waiting for ready() before they are checked again. */
  private readonly waiting = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** `run` checks a source, and reads it again when it changed. */
  constructor(run: (source: string) => Promise<Refreshed>) {
    this.run = run;
  }

  /** Takes the charts' schedules, after every change to the charts. */
  plan(dues: readonly Due[]): void {
    this.every.clear();
    for (const { source, everyMs } of dues) {
      this.every.set(source, Math.min(everyMs, this.every.get(source) ?? everyMs));
    }
    this.tick();
  }

  /** Says a source's index completed, so one waiting on it is checked now. */
  ready(source: string): void {
    if (!this.waiting.delete(source)) return;
    this.checked.delete(source);
    this.tick();
  }

  /** Checks every source that came due while the machine slept or the page was away. */
  wake(): void {
    this.tick();
  }

  /** Stops the timer and drops the schedules, so a check still out starts nothing. */
  dispose(): void {
    this.every.clear();
    clearTimeout(this.timer);
  }

  /** Checks every overdue source with no check out, and sets the timer for the next. */
  private tick(): void {
    clearTimeout(this.timer);
    const now = Date.now();
    let next = Infinity;
    for (const [source, everyMs] of this.every) {
      if (this.running.has(source) || this.waiting.has(source)) continue;
      const last = this.checked.get(source);
      const due = last === undefined ? now : last + everyMs;
      if (due <= now) void this.check(source);
      else next = Math.min(next, due);
    }
    if (next !== Infinity) this.timer = setTimeout(() => this.tick(), next - now);
  }

  /** Checks one source, and sets the timer again once it ends. */
  private async check(source: string): Promise<void> {
    this.running.add(source);
    const done = await this.run(source);
    if (done.t === "waiting") this.waiting.add(source);
    this.running.delete(source);
    this.checked.set(source, Date.now());
    this.tick();
  }
}
