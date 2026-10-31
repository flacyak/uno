/**
 * @fileoverview One workspace's charts. The engine keeps the records a save
 * writes, and this model mirrors them for the windows over the sheet. It puts
 * and removes through the engine.
 *
 * This file is plain logic, so tests run it directly.
 */

import type { Chart } from "@document";
import { Refusal } from "@engine";
import type { Engine } from "@engine";

/** What a person changes in a chart's form. */
export type Shown = Pick<Chart, "source" | "plot" | "title" | "refresh">;

export class Charts {
  /** The charts by id, oldest first, as the engine answered for them. */
  private readonly answered = new Map<string, Chart>();
  /** The count behind the ids uno makes. */
  private made = 0;

  constructor(private readonly engine: Engine) {}

  /** The charts, oldest first. */
  get all(): readonly Chart[] {
    return [...this.answered.values()];
  }

  /** The charts over a source, oldest first. */
  over(source: string): readonly Chart[] {
    return this.all.filter((chart) => chart.source === source);
  }

  /** Adds a chart under a new id and returns it. A refused chart is not kept. */
  async add(chart: Omit<Chart, "id">): Promise<Chart> {
    const made = { ...chart, id: `c${++this.made}` };
    await this.put(made);
    return made;
  }

  /** Changes what a chart shows. A refused change is not kept. */
  async change(id: string, shown: Partial<Shown>): Promise<void> {
    const chart = this.answered.get(id);
    if (chart === undefined) throw new Refusal({ t: "no-such-chart", id });
    await this.put({ ...chart, ...shown });
  }

  /** Removes a chart. A refused removal leaves it. */
  async remove(id: string): Promise<void> {
    await this.engine.unchart(id);
    this.answered.delete(id);
  }

  /** Forgets the charts over a source, which left the engine with it. */
  dropSource(source: string): void {
    for (const chart of this.over(source)) this.answered.delete(chart.id);
  }

  /** Sends `chart` to the engine, and keeps it once the engine has it. */
  private async put(chart: Chart): Promise<void> {
    await this.engine.chart(chart);
    this.answered.set(chart.id, chart);
  }
}
