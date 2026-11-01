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
import { dragged, nudged, placeOf, placed, tucks } from "./place.ts";
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

/** A pointer that holds a window. */
interface Hold {
  /** Where it took hold, in the page's CSS px. */
  x: number;
  y: number;
  /** The rect the window stood at then. */
  from: Rect;
  /** The rect it has taken the window to, once it moves. */
  to?: Rect;
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
  /** The pointer that holds the window, while one does. */
  private hold: Hold | undefined;

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
    head.addEventListener("pointerdown", (e) => this.take(e, head));

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
    // A pointer's capture sends these to the zone it pressed, and they bubble here.
    this.box.addEventListener("pointermove", (e) => this.follow(e));
    this.box.addEventListener("pointerup", () => this.drop());
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

  /** stand puts the window at `rect`, unless a pointer holds it. */
  stand(rect: Rect): void {
    if (this.hold === undefined) standAt(this.box, rect);
  }

  /** relabel writes the window's own words in the current language. */
  relabel(): void {
    this.words.write();
  }

  /**
   * take answers a press on `zone`, which holds the pointer from then on. The
   * press commits an open cell, through its blur. It stays uncancelled, so its
   * mousedown reaches what closes an open menu or form.
   */
  private take(e: PointerEvent, zone: HTMLElement): void {
    this.box.focus({ preventScroll: true });
    const room = this.stage.room();
    zone.setPointerCapture(e.pointerId);
    const from = placed(this.chart.place, room);
    this.hold = { x: e.clientX, y: e.clientY, from };
  }

  /** follow stands the window where its pointer has gone, in the room as it is now. */
  private follow(e: PointerEvent): void {
    const hold = this.hold;
    if (hold === undefined) return;
    hold.to = dragged(hold.from, e.clientX - hold.x, e.clientY - hold.y, this.stage.room());
    standAt(this.box, hold.to);
  }

  /** drop stores where the pointer left the window. */
  private drop(): void {
    if (this.hold === undefined) return;
    const to = this.hold.to ?? this.hold.from;
    this.hold = undefined;
    this.store(to, this.stage.room());
    this.stage.draw();
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
