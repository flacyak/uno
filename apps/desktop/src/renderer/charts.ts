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
import type { Chart, ChartColumn, ChartPlace, Plot, TimePlot } from "@document";
import { Refusal } from "@engine";
import type { Drawn } from "./chart/kind.ts";
import { inSlots, slotted } from "./chart/slots.ts";
import type { Added, CarriedPlace, Engine, Place, Tally } from "@engine";
import type { Per, TimeLevel } from "@tally";

import type { State } from "./sources.ts";

/** What a person changes in a chart's form. */
export type Shown = Pick<Chart, "source" | "plot" | "title" | "refresh">;

/** The tallies of one plot over one source, as a chart heard them. */
interface Tallied {
  source: string;
  latest: Tally;
  complete: Drawn | undefined;
  /** Whether the source is being read again, with no tally of it heard yet. */
  rereading?: boolean;
  /** A stacked chart's series in the slots they wear, as slots.ts keeps them. */
  slots?: readonly string[];
}

/** A chart's source, as its window says it when it has nothing of it to draw. */
export interface SourceState {
  /** The state of the chart's source. A source that is missing or waits on its
   * bucket posts no tally until it is pointed at a file. A source the workspace
   * does not hold reads as missing. */
  state: State;
  /** The source's file name, or its id for one the workspace does not hold. */
  name: string;
  /** The bucket the source waits on, while it is unconnected. */
  bucket?: string;
  /** Whether the source's file is carried inside the workspace, with none to read again. */
  carried?: boolean;
  /** Whether the source's files were not found when the workspace opened, with
   * no path to read again. */
  lost?: boolean;
}

/** What a chart's window draws from. */
export interface Heard extends SourceState {
  /** The latest tally of what the chart shows, once one has come. */
  latest: Tally | undefined;
  /** The last complete one, which stays until the next one completes. */
  complete: Drawn | undefined;
  /** Whether the source is being read again, with no tally of it heard yet. */
  rereading?: boolean;
}

/** The columns a plot reads, in the order its kind names them. */
function columnsOf(plot: Plot): ReadonlyArray<ChartColumn | undefined> {
  if (plot.t === "scatter") return [plot.x, plot.y];
  if (plot.t === "stack") return [plot.by, plot.split, plot.sum];
  if (plot.t === "histogram") return [plot.of];
  if (plot.t === "box") return [plot.of, plot.by];
  if (plot.t === "dots") return [plot.by, plot.of];
  return plot.t === "time" ? [plot.at, plot.sum] : [plot.by, plot.sum];
}

/** Returns whether two plots draw one kind from the same columns, a dot plot's at one measure. */
function samePlot(a: Plot, b: Plot): boolean {
  const theirs = columnsOf(b);
  const measure = (plot: Plot) => (plot.t === "dots" ? plot.measure : undefined);
  return (
    a.t === b.t &&
    measure(a) === measure(b) &&
    columnsOf(a).every((c, i) => c?.col === theirs[i]?.col && c?.header === theirs[i]?.header)
  );
}

/** Returns whether two plots read their dates alike at one size, as any two not over time do. */
function sameReading(a: Plot, b: Plot): boolean {
  if (a.t !== "time" || b.t !== "time") return true;
  const reading = (plot: TimePlot): string => ("order" in plot ? plot.order : plot.unit);
  return a.per === b.per && reading(a) === reading(b);
}

/** Returns whether two plots stand the same bars first, as a person moved them. */
function sameOrder(a: Plot, b: Plot): boolean {
  const moved = (plot: Plot): string =>
    JSON.stringify("order" in plot && plot.t !== "time" ? plot.order : []);
  return moved(a) === moved(b);
}

/** Returns whether two records show the same. Neither's place counts. */
function sameShown(a: Chart, b: Chart): boolean {
  return (
    a.source === b.source &&
    a.title === b.title &&
    a.refresh === b.refresh &&
    samePlot(a.plot, b.plot) &&
    sameReading(a.plot, b.plot) &&
    sameOrder(a.plot, b.plot)
  );
}

/** Returns whether `held` are tallies of `plot` over `source`. */
function reads(held: Tallied | undefined, source: string, plot: Plot): held is Tallied {
  return held?.source === source && samePlot(held.latest.plot, plot);
}

/**
 * joined gives `level` with `batch` after the periods it holds, where the
 * batch is of its size and span and starts where they end, or `level` as it
 * is where the fold has moved since or the batch is another's.
 */
function joined(level: TimeLevel, batch: TimeLevel): TimeLevel {
  const { per, from, span, offset } = batch;
  const next = per === level.per && from === level.from && span === level.span;
  if (!next || offset !== level.rows.length) return level;
  return { ...level, rows: [...level.rows, ...batch.rows], sum: [...level.sum, ...batch.sum] };
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
  /** The batches asked for and not yet answered, by chart id, size and offset. */
  private readonly asking = new Set<string>();
  /** Every id held, carried or made, so a new chart takes none of them. */
  private readonly taken = new Set<string>();
  /** The sources of the charts this workspace carries and cannot show. */
  private readonly carrying = new Set<string>();
  /** Where the windows of those charts stand, by id, for those whose records give a place. */
  private readonly kept = new Map<string, CarriedPlace>();
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
    /** A source as a chart over it says it. */
    private readonly sourceState: (source: string) => SourceState,
    /** What a chart's head calls a source, when it has to name one at all. */
    readonly sourceLabel: (source: string) => string | undefined,
  ) {}

  /** Takes the charts an open found, which count as saved, and the ids and
   * sources of the ones it carries. */
  seed(opening: Pick<Added, "charts" | "carriedIds" | "carriedOver" | "carriedPlaces">): void {
    for (const chart of opening.charts) {
      this.answered.set(chart.id, chart);
      this.recorded.set(chart.id, chart);
      this.taken.add(chart.id);
    }
    for (const id of opening.carriedIds) this.taken.add(id);
    for (const source of opening.carriedOver) this.carrying.add(source);
    for (const carried of opening.carriedPlaces) this.kept.set(carried.id, carried);
  }

  /** The windows of the charts this workspace carries and cannot show, where they stand. */
  get carried(): readonly CarriedPlace[] {
    return [...this.kept.values()];
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

  /** Whether every chart's latest tally is complete, so a save keeps each whole fold. */
  get folded(): boolean {
    return this.all.every((chart) => {
      const held = this.tallied.get(chart.id);
      if (!reads(held, chart.source, chart.plot)) return false;
      return held.latest.t !== "unread" && held.latest.coverage.complete;
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
  hear(source: string, id: string, heard: Tally): void {
    const was = this.tallied.get(id);
    const same = reads(was, source, heard.plot);
    // A stack's series keep their slots while the plot and the source stay.
    let slots = same ? was.slots : undefined;
    let tally = heard;
    if (heard.t === "stack") {
      slots = slotted(slots ?? [], heard.series);
      tally = inSlots(heard, slots);
    }
    const kept = same ? was.complete : undefined;
    const complete = tally.t !== "unread" && tally.coverage.complete ? tally : kept;
    this.tallied.set(id, { source, latest: tally, complete, ...(slots && { slots }) });
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
      ...this.sourceState(chart.source),
      latest: current ? held.latest : undefined,
      complete: current ? held.complete : undefined,
      rereading: current && held.rereading === true,
    };
  }

  /**
   * batch asks the engine for chart `id`'s periods at `per` from `offset`, once
   * at a time, and joins them to its last complete tally. It resolves to
   * whether they joined, which none do where the chart or its tally has gone
   * or its fold has moved since.
   */
  async batch(id: string, per: Per, offset: number): Promise<boolean> {
    const asked = `${id} ${per} ${offset}`;
    if (this.asking.has(asked)) return false;
    this.asking.add(asked);
    try {
      const batch = await this.engine.batch(id, per, offset);
      const held = this.tallied.get(id);
      const complete = held?.complete;
      if (batch === undefined || held === undefined || complete?.t !== "time") return false;
      const levels = complete.levels.map((level) => joined(level, batch));
      if (levels.every((level, i) => level === complete.levels[i])) return false;
      this.tallied.set(id, { ...held, complete: { ...complete, levels } });
      return true;
    } catch (e) {
      if (e instanceof Refusal) return false;
      throw e;
    } finally {
      this.asking.delete(asked);
    }
  }

  /** Notes that `source` is being read again: each chart over it is reading
   * from the start until the first tally of the new read comes. */
  reread(source: string): void {
    for (const [id, held] of this.tallied) {
      if (held.source === source) this.tallied.set(id, { ...held, rereading: true });
    }
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
    for (const carried of this.kept.values()) {
      if (carried.source === source) this.kept.delete(carried.id);
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
