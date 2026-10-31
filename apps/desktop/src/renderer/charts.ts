/**
 * @fileoverview One workspace's charts. The engine keeps the records a save
 * writes, and this model mirrors them for the windows over the sheet. A change
 * shows at once and goes through the engine, and a refusal puts back what the
 * engine holds. It makes each new chart's id, knows which changes a save has
 * yet to record, and holds what each chart last heard from its source.
 *
 * This file is plain logic, so tests run it directly.
 */

import { isPlace } from "@document";
import type { Chart, ChartColumn, ChartPlace, Plot } from "@document";
import { Refusal } from "@engine";
import type { Added, Engine, GroupsTally, Place, SampleTally, Tally } from "@engine";

/** What a person changes in a chart's form. */
export type Shown = Pick<Chart, "source" | "plot" | "title" | "refresh">;

/** The tallies of one plot over one source, as a chart heard them. */
interface Tallied {
  source: string;
  latest: Tally;
  complete: GroupsTally | SampleTally | undefined;
}

/** What a chart's window draws from. */
export interface Heard {
  /** The latest tally of what the chart shows, once one has come. */
  latest: Tally | undefined;
  /** The last complete one, which stays until the next one completes. */
  complete: GroupsTally | SampleTally | undefined;
}

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

/** Returns whether `held` are tallies of `plot` over `source`. */
function reads(held: Tallied | undefined, source: string, plot: Plot): held is Tallied {
  return held?.source === source && samePlot(held.latest.plot, plot);
}

export class Charts {
  /** The charts by id, oldest first, as the engine answered for them. */
  private readonly answered = new Map<string, Chart>();
  /** The latest request on its way for each chart, shown over the answered
   * record until it lands: the record sent, or undefined for a removal. */
  private readonly sent = new Map<string, Chart | undefined>();
  /** Where each moved window stands, over its chart's record. */
  private readonly moved = new Map<string, ChartPlace>();
  /** What each chart last heard. It stays through a change, so a refusal
   * gives it back. */
  private readonly tallied = new Map<string, Tallied>();
  /** Every id held, carried or made, so a new chart takes none of them. */
  private readonly taken = new Set<string>();
  /** The sources of the charts this workspace carries and cannot show. */
  private readonly carrying = new Set<string>();
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

  /** Takes the charts an open found, which count as saved, and the ids and
   * sources of the ones it carries. */
  seed(opening: Pick<Added, "charts" | "carriedIds" | "carriedOver">): void {
    for (const chart of opening.charts) {
      this.answered.set(chart.id, chart);
      this.recorded.set(chart.id, chart);
      this.taken.add(chart.id);
    }
    for (const id of opening.carriedIds) this.taken.add(id);
    for (const source of opening.carriedOver) this.carrying.add(source);
  }

  /** The charts as their windows show them, oldest first. */
  get all(): readonly Chart[] {
    // A Map keeps a key where it first stood, so a change stays in line and a
    // new chart comes last.
    const shown = new Map<string, Chart | undefined>([...this.answered, ...this.sent]);
    return [...shown.values()]
      .filter((chart) => chart !== undefined)
      .map((chart) => ({ ...chart, place: this.moved.get(chart.id) ?? chart.place }));
  }

  /** The charts over a source, oldest first. */
  over(source: string): readonly Chart[] {
    return this.all.filter((chart) => chart.source === source);
  }

  /** Whether a chart leaves with a source, shown or carried. */
  leaveWith(source: string): boolean {
    return this.carrying.has(source) || this.over(source).length > 0;
  }

  /** Where each window stands, for a save to write. */
  get places(): NonNullable<Place["charts"]> {
    return this.all.map(({ id, place }) => ({ id, place }));
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

  /** Stands a chart's window at `place`. The next save writes it, as it does
   * the selected cell, so a move asks nothing of the engine. A place a read
   * would refuse leaves it where it stood, so no change is refused over it. */
  move(id: string, place: ChartPlace): void {
    if (isPlace(place)) this.moved.set(id, place);
  }

  /** Takes a tally of chart `id` from `source`. The last complete tally stays
   * until the next, while the plot and the source are the same. */
  hear(source: string, id: string, tally: Tally): void {
    const was = this.tallied.get(id);
    const kept = reads(was, source, tally.plot) ? was.complete : undefined;
    const complete = tally.t !== "unread" && tally.coverage.complete ? tally : kept;
    this.tallied.set(id, { source, latest: tally, complete });
  }

  /** What chart `id`'s window draws from, or undefined for a chart that has
   * gone. It leaves out tallies of another plot or source, since a chart shows
   * a change at once, and a view posts for what it holds until the change
   * reaches it. */
  heard(id: string): Heard | undefined {
    const chart = this.all.find((c) => c.id === id);
    if (chart === undefined) return undefined;
    const held = this.tallied.get(id);
    const current = reads(held, chart.source, chart.plot);
    return {
      latest: current ? held.latest : undefined,
      complete: current ? held.complete : undefined,
    };
  }

  /** Forgets the charts over a source, which left the engine with it, and
   * their tallies. */
  dropSource(source: string): void {
    for (const chart of this.answered.values()) {
      if (chart.source !== source) continue;
      this.answered.delete(chart.id);
      this.tallied.delete(chart.id);
    }
    this.carrying.delete(source);
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
      if (record === undefined) {
        this.answered.delete(id);
        this.tallied.delete(id);
      } else {
        this.answered.set(id, record);
      }
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
