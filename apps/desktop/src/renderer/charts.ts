/**
 * @fileoverview One workspace's charts. The engine keeps the records a save
 * writes, and this model mirrors them for the windows over the sheet. A change
 * shows at once and goes through the engine, and a refusal puts back what the
 * engine holds. It makes each new chart's id, and knows which changes a save
 * has yet to record.
 *
 * This file is plain logic, so tests run it directly.
 */

import type { Chart, ChartColumn, Plot } from "@document";
import { Refusal } from "@engine";
import type { Added, Engine } from "@engine";

/** What a person changes in a chart's form. */
export type Shown = Pick<Chart, "source" | "plot" | "title" | "refresh">;

/** The columns a plot reads, in the order its kind names them. */
function columnsOf(plot: Plot): ReadonlyArray<ChartColumn | undefined> {
  return plot.t === "scatter" ? [plot.x, plot.y] : [plot.by, plot.sum];
}

/** Returns whether two plots draw one kind from the same columns. */
function samePlot(a: Plot, b: Plot): boolean {
  const theirs = columnsOf(b);
  return (
    a.t === b.t &&
    columnsOf(a).every((c, i) => c?.col === theirs[i]?.col && c?.header === theirs[i]?.header)
  );
}

/** Returns whether two records show the same. Neither's place counts. */
function sameShown(a: Chart, b: Chart): boolean {
  return (
    a.source === b.source &&
    a.title === b.title &&
    a.refresh === b.refresh &&
    samePlot(a.plot, b.plot)
  );
}

export class Charts {
  /** The charts by id, oldest first, as the engine answered for them. */
  private readonly answered = new Map<string, Chart>();
  /** The latest request on its way for each chart, shown over the answered
   * record until it lands: the record sent, or undefined for a removal. */
  private readonly sent = new Map<string, Chart | undefined>();
  /** Every id held, carried or made, so a new chart takes none of them. */
  private readonly taken = new Set<string>();
  /** The count behind the ids uno makes. */
  private made = 0;
  /** The charts as the last save recorded them. */
  private recorded = new Map<string, Chart>();
  /** The charts as the last save wrote them, recorded once its file is. */
  private written = this.recorded;

  constructor(
    private readonly engine: Engine,
    /** Counts a request as a write until the engine answers it. */
    private readonly writing: (write: Promise<void>) => Promise<void>,
  ) {}

  /** Takes the charts an open found, which count as saved, and the ids of the
   * ones it carries. */
  seed({ charts, carriedIds }: Pick<Added, "charts" | "carriedIds">): void {
    for (const chart of charts) {
      this.answered.set(chart.id, chart);
      this.recorded.set(chart.id, chart);
      this.taken.add(chart.id);
    }
    for (const id of carriedIds) this.taken.add(id);
  }

  /** The charts as their windows show them, oldest first. */
  get all(): readonly Chart[] {
    // A Map keeps a key where it first stood, so a change stays in line and a
    // new chart comes last.
    const shown = new Map<string, Chart | undefined>([...this.answered, ...this.sent]);
    return [...shown.values()].filter((chart) => chart !== undefined);
  }

  /** The charts over a source, oldest first. */
  over(source: string): readonly Chart[] {
    return this.all.filter((chart) => chart.source === source);
  }

  /** Whether a chart was added, removed or changed since the last save. */
  get dirty(): boolean {
    if (this.answered.size !== this.recorded.size) return true;
    return [...this.answered.values()].some((chart) => {
      const was = this.recorded.get(chart.id);
      return was === undefined || !sameShown(chart, was);
    });
  }

  /** Adds a chart under a new id and returns it. It shows at once, and a
   * refusal takes it away. */
  async add(chart: Omit<Chart, "id">): Promise<Chart> {
    const made = { ...chart, id: this.mint() };
    await this.send(made.id, made, this.engine.chart(made));
    return made;
  }

  /** Changes what a chart shows, over any change still on its way. It shows at
   * once, and a refusal puts it back. */
  async change(id: string, shown: Partial<Shown>): Promise<void> {
    const chart = { ...this.need(id), ...shown };
    await this.send(id, chart, this.engine.chart(chart));
  }

  /** Removes a chart. It goes at once, and a refusal brings it back. */
  async remove(id: string): Promise<void> {
    this.need(id);
    await this.send(id, undefined, this.engine.unchart(id));
  }

  /** Forgets the charts over a source, which left the engine with it. */
  dropSource(source: string): void {
    for (const chart of this.answered.values()) {
      if (chart.source === source) this.answered.delete(chart.id);
    }
  }

  /** Notes the charts answered for now as the ones a save wrote. */
  wrote(): void {
    this.written = new Map(this.answered);
  }

  /** Records what the last save wrote, now its file is written. */
  saved(): void {
    this.recorded = this.written;
  }

  /** The chart with the id as its window shows it. One that has gone is
   * refused as the engine refuses it. */
  private need(id: string): Chart {
    const chart = this.all.find((c) => c.id === id);
    if (chart === undefined) throw new Refusal({ t: "no-such-chart", id });
    return chart;
  }

  /** Shows `record` for chart `id`, or no chart for a removal, until `request`
   * lands. The engine's answer keeps it. A refusal leaves what the engine
   * holds, or a later request shown over it. */
  private async send(id: string, record: Chart | undefined, request: Promise<void>): Promise<void> {
    this.sent.set(id, record);
    try {
      await this.writing(request);
      if (record === undefined) this.answered.delete(id);
      else this.answered.set(id, record);
    } finally {
      if (this.sent.get(id) === record) this.sent.delete(id);
    }
  }

  /** Returns the next of 'c1', 'c2', ... that no chart of the workspace has. */
  private mint(): string {
    let id: string;
    do {
      id = `c${++this.made}`;
    } while (this.taken.has(id));
    this.taken.add(id);
    return id;
  }
}
