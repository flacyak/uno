/**
 * @fileoverview One workspace's charts. The engine keeps the records a save
 * writes, and this model mirrors them for the windows over the sheet.
 *
 * This file is plain logic, so tests run it directly.
 */

import type { Chart } from "@document";
import type { Engine } from "@engine";

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

  /** Adds a chart under a new id and returns it. A refused chart is not kept. */
  async add(chart: Omit<Chart, "id">): Promise<Chart> {
    const made = { ...chart, id: `c${++this.made}` };
    await this.engine.chart(made);
    this.answered.set(made.id, made);
    return made;
  }
}
