/**
 * @fileoverview A stacked chart's legend: a key per series in slot order, then
 * Other, in lines that wrap above the bars, laid out here by the plot's width
 * in mono characters, so the bars keep the height the lines leave.
 */

import { m } from "@paraglide/messages";
import { num } from "@renderer/locale";
import { el } from "@renderer/shell/util";
import type { PlotRoom } from "./kind.ts";
import { BARS_INSET } from "./rows.ts";

/** The characters of a name a key shows; the title and the table hold all. */
export const LEGEND_NAME_AT_MOST = 18;

/** The most of a plot's height the legend takes, so the bars keep the rest. */
export const LEGEND_SHARE_AT_MOST = 0.4;

/** A key's swatch, the gap after it, and the gap between two keys, in px: the pie's key and the design's. */
export const KEY_SIZE = 10;
export const KEY_GAP = 4;
export const ENTRY_GAP = 12;

/** A line of keys, in px: the 11 px names and their leading. */
export const LEGEND_LINE = 16;

/** One key: the colour it wears, and its series, or none for Other. */
export interface Entry {
  key: string;
  series: string | undefined;
}

/** words gives what a key says: the file's text, the app's word for a blank, or Other. */
function words(series: string | undefined): string {
  if (series === undefined) return m.chart_pie_other();
  return series === "" ? m.chart_blank_value() : series;
}

/** Splits a name into the letters a reader sees, each a mono character. */
const LETTERS = new Intl.Segmenter();

/** widthOf gives the px a key takes beside the next, its name cut as the key cuts it. */
function widthOf(said: string, ch: number): number {
  const shown = Math.min([...LETTERS.segment(said)].length, LEGEND_NAME_AT_MOST);
  return KEY_SIZE + KEY_GAP + shown * ch + ENTRY_GAP;
}

/** item gives one key: its swatch and its name, whole in its title. */
function item({ key, series }: Entry): HTMLElement {
  const said = words(series);
  const swatch = el("span", "chart-legend-key");
  swatch.style.setProperty("--key", key);
  const name =
    series === undefined
      ? el("span", "chart-key-name", said)
      : series === ""
        ? el("span", "chart-key-name chart-blank", said)
        : el("bdi", "chart-key-name from-file", said);
  const made = el("li");
  made.title = said;
  made.append(swatch, name);
  return made;
}

/**
 * legend lays `entries` out in lines across `room`, as many as
 * LEGEND_SHARE_AT_MOST of a plot `height` px high holds, at least one. Where
 * they do not all fit, the last line ends in how many more the table holds.
 */
export function legend(
  entries: readonly Entry[],
  room: PlotRoom,
  height: number,
): { box: HTMLElement; height: number } {
  const across = room.width - 2 * BARS_INSET + ENTRY_GAP;
  const most = Math.max(1, Math.floor((height * LEGEND_SHARE_AT_MOST) / LEGEND_LINE));
  const more = (count: number) => m.chart_bars_more({ count: num(count) });
  let lines = 1;
  let used = 0;
  let fit = 0;
  for (const [i, entry] of entries.entries()) {
    const width = widthOf(words(entry.series), room.ch);
    // The last line keeps room for what says how many more, past this key.
    const after = lines === most && i < entries.length - 1 ? more(entries.length - i - 1) : "";
    const needs = width + (after === "" ? 0 : after.length * room.ch);
    if (used + needs > across && used > 0) {
      if (lines === most) break;
      lines++;
      used = 0;
    }
    used += width;
    fit++;
  }
  const box = el("ul", "chart-key-list");
  box.append(...entries.slice(0, fit).map(item));
  if (fit < entries.length) box.append(el("li", "chart-key-more", more(entries.length - fit)));
  return { box, height: lines * LEGEND_LINE + BARS_INSET };
}
