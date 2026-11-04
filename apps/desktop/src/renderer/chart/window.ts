/**
 * @fileoverview A chart's window: the dialogs' box, with a head that says what
 * the chart shows, a round × of the window's own kind, and a caption that ends
 * in a grip. The layer stands it in the room and says which chart it shows.
 */

import type { Chart, ChartColumn, ChartPlace, Plot } from "@document";
import { m } from "@paraglide/messages";
import { columnLabel } from "@renderer/grid/rows";
import { pressOf } from "@renderer/keys";
import type { Press } from "@renderer/keys";
import { Words, el } from "@renderer/shell/util";
import { nudged, placeOf, placed, tucks } from "./place.ts";
import type { Rect, Room } from "./place.ts";

/** The × on the window's own close button, drawn in currentColor. */
const CROSS =
  '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">' +
  '<path d="M2 2l6 6M8 2l-6 6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
  "</svg>";

/** The grip's two diagonal strokes, drawn in currentColor. */
const GRIP =
  '<svg viewBox="0 0 12 12" width="12" height="12">' +
  '<path d="M10 3l-7 7M10 7l-3 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
  "</svg>";

/** How many windows have been made, so each one's ids are its own. A chart's
 * id can be any name, and aria-labelledby reads a space as a second id. */
let made = 0;

/** What a window asks of the layer it stands in. */
export interface Stage {
  /** The room as it measures now. */
  room(): Room;
  /** Stores where chart `id`'s window stands, for the next save to write. */
  move(id: string, place: ChartPlace): void;
  /** Stands every window where its chart says. */
  draw(): void;
  /** Gives the keys back to the grid. */
  leave(): void;
}

/** madeTitle gives the title a plot makes, in the app's language. */
export function madeTitle(plot: Plot): string {
  const named = ({ header, col }: ChartColumn): string => columnLabel(header, col);
  if (plot.t === "scatter") return m.chart_title_against({ x: named(plot.x), y: named(plot.y) });
  const by = named(plot.by);
  const sum = plot.sum === undefined ? undefined : named(plot.sum);
  if (plot.t === "bars") {
    return sum === undefined ? m.chart_title_rows({ by }) : m.chart_title_sum({ by, sum });
  }
  return sum === undefined
    ? m.chart_title_share_of_rows({ by })
    : m.chart_title_share_of_sum({ by, sum });
}

/** standAt puts a window at `rect`, in the layer's CSS px. */
function standAt(box: HTMLElement, rect: Rect): void {
  box.style.left = `${rect.x}px`;
  box.style.top = `${rect.y}px`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
}

export class ChartWindow {
  /** The whole window, which the layer stands in the room. */
  readonly box = el("div", "chart");
  private readonly title = el("span", "chart-title");
  /** The words that stay whichever chart the window shows. */
  private readonly words = new Words();

  constructor(
    /** The chart the window shows, as the layer last said. */
    private chart: Chart,
    private readonly stage: Stage,
  ) {
    const id = `chart-${++made}`;
    const caption = el("div", "chart-caption");
    caption.id = `${id}-caption`;
    this.title.id = `${id}-title`;

    const x = el("button", "round-x chart-close");
    x.type = "button";
    x.innerHTML = CROSS;
    this.words.attr(x, "aria-label", m.chart_remove_aria);

    const head = el("div", "col-head chart-head");
    head.append(this.title, x);

    const grip = el("span", "chart-grip");
    grip.innerHTML = GRIP;
    grip.setAttribute("aria-hidden", "true");
    caption.append(grip);

    this.box.tabIndex = -1;
    this.box.setAttribute("role", "group");
    this.box.setAttribute("aria-labelledby", this.title.id);
    this.box.setAttribute("aria-describedby", caption.id);
    this.words.attr(this.box, "aria-roledescription", m.chart_role);
    this.box.append(head, el("div", "chart-plot"), caption);
    this.box.addEventListener("keydown", (e) => this.key(e));
  }

  /** show writes what `chart` says in the head, after `source` if it has one. */
  show(chart: Chart, source: string | undefined): void {
    this.chart = chart;
    const title = el("bdi", "", chart.title === "" ? madeTitle(chart.plot) : chart.title);
    if (source === undefined) this.title.replaceChildren(title);
    else this.title.replaceChildren(el("bdi", "from-file", source), " · ", title);
    this.title.title = this.title.textContent;
    this.title.classList.toggle("from-file", chart.title !== "");
  }

  /** stand puts the window at `rect`. */
  stand(rect: Rect): void {
    standAt(this.box, rect);
  }

  /** relabel writes the window's own words in the current language. */
  relabel(): void {
    this.words.write();
  }

  /** store keeps `rect` as the chart's place. A tucked window's rect has none. */
  private store(rect: Rect, room: Room): void {
    if (!tucks(room)) this.stage.move(this.chart.id, placeOf(rect, room, this.chart.place));
  }

  /** key answers Escape and the arrows, and leaves any other key to the shell. */
  private key(e: KeyboardEvent): void {
    if (e.key === "Escape") this.stage.leave();
    else if (!this.nudge(pressOf(e))) return;
    e.preventDefault();
    e.stopPropagation();
  }

  /**
   * nudge stands the window where `press` steps it, and returns whether it is
   * an arrow.
   */
  private nudge(press: Press): boolean {
    const room = this.stage.room();
    const to = nudged(placed(this.chart.place, room), press, room);
    if (to === undefined) return false;
    this.store(to, room);
    this.stage.draw();
    return true;
  }
}
