/**
 * @fileoverview The schedule of one workspace's charts. Each source a chart
 * refreshes on a schedule is checked at the shortest interval among its
 * charts, an interval after its last check ended.
 *
 * This file is plain logic, so tests run it directly.
 */

/** A chart's schedule: its source, checked every `everyMs`. */
export interface Due {
  source: string;
  everyMs: number;
}

/** Checks a workspace's scheduled sources on time, with one timer. */
export class Refresher {
  private readonly run: (source: string) => Promise<void>;
  /** The shortest interval among each scheduled source's charts. */
  private readonly every = new Map<string, number>();
  /** When each source's last check ended, in ms since 1970. One not here is due now. */
  private readonly checked = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** `run` checks a source, and reads it again when it changed. */
  constructor(run: (source: string) => Promise<void>) {
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

  /** Checks every overdue source, and sets the timer for the next. */
  private tick(): void {
    clearTimeout(this.timer);
    const now = Date.now();
    let next = Infinity;
    for (const [source, everyMs] of this.every) {
      const last = this.checked.get(source);
      const due = last === undefined ? now : last + everyMs;
      if (due <= now) void this.check(source);
      else next = Math.min(next, due);
    }
    if (next !== Infinity) this.timer = setTimeout(() => this.tick(), next - now);
  }

  /** Checks one source, and sets the timer again once it ends. */
  private async check(source: string): Promise<void> {
    await this.run(source);
    this.checked.set(source, Date.now());
    this.tick();
  }
}
