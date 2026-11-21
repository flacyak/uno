/**
 * @fileoverview The chart form's kinds: a tile per kind of chart, in a row
 * for the question it answers, every row on one grid. The tiles are radios
 * of one name, so the arrows step through every kind and Enter makes the
 * chart chosen, and a screen reader hears them as one group.
 */

import type { Plot } from "@document";
import { m } from "@paraglide/messages";
import { el } from "@renderer/shell/util";

/** A question a chart answers, and the kinds the form offers for it, in order. */
export interface Question {
  words: () => string;
  kinds: ReadonlyArray<readonly [Plot["t"], () => string]>;
}

/** The kinds of chart, under the questions they answer, in the order the form offers them. */
export const QUESTIONS: readonly Question[] = [
  {
    words: m.chart_kinds_compare,
    kinds: [
      ["bars", m.chart_kind_bars],
      ["dots", m.chart_kind_dots],
      ["pie", m.chart_kind_pie],
    ],
  },
  { words: m.chart_kinds_trend, kinds: [["time", m.chart_kind_time]] },
  {
    words: m.chart_kinds_spread,
    kinds: [
      ["histogram", m.chart_kind_histogram],
      ["box", m.chart_kind_box],
    ],
  },
  { words: m.chart_kinds_relate, kinds: [["scatter", m.chart_kind_scatter]] },
];

/** KindTiles is the form's rows of kind tiles, which stand among its fields. */
export class KindTiles {
  readonly box = el("div", "chart-kinds");
  private readonly radios: HTMLInputElement[] = [];

  constructor(questions: readonly Question[]) {
    this.box.setAttribute("role", "radiogroup");
    this.box.setAttribute("aria-label", m.chart_form_kind());
    for (const { words, kinds } of questions) {
      const tiles = el("div", "chart-tiles");
      for (const [t, said] of kinds) {
        const radio = el("input");
        radio.type = "radio";
        radio.name = "kind";
        radio.value = t;
        const tile = el("label", "chart-tile");
        tile.append(radio, el("span", "", said()));
        tiles.append(tile);
        this.radios.push(radio);
      }
      const line = el("div", "field");
      line.append(el("span", "what", words()), tiles);
      this.box.append(line);
    }
    // The first kind is chosen until another is, as a select's first option is.
    this.radios[0]!.checked = true;
  }

  /** The kind chosen. */
  get value(): string {
    return this.radios.find((radio) => radio.checked)?.value ?? "";
  }

  set value(t: string) {
    for (const radio of this.radios) radio.checked = radio.value === t;
  }

  /** disable turns kind `t`'s tile off, or on again. */
  disable(t: string, off: boolean): void {
    for (const radio of this.radios) if (radio.value === t) radio.disabled = off;
  }
}
