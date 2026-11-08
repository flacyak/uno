/**
 * @fileoverview A chart's window: the dialogs' box, with a head that says what
 * the chart shows, a round × of the window's own kind, and a caption that ends
 * in a grip. The layer stands it in the room and says which chart it shows.
 *
 * A pointer on the head moves the window, and one on the grip or an edge
 * resizes it. It follows the pointer alone until the drop, which stores where
 * it stands, so a window put back has changed nothing. An arrow stores a step
 * at once. A place asks nothing of the engine and marks nothing unsaved.
 *
 * The sheet scrolls under a window: a wheel over one goes on to the grid, unless
 * something inside the window can still scroll that way.
 *
 * The plot draws what the chart last heard, each time the layer shows the
 * window, as the window resizes, and when the chart hears a tally. The
 * drawing is an image a screen reader hears named by what the chart says it
 * shows, from the last complete tally, and t puts the table of the same in
 * its place, and back. The pointer over a mark shows what it is worth in a
 * box beside it, and the arrows step the box through the marks while the
 * plot has the keys. The caption's count of the cells that were not numbers
 * is a button that finds them in the sheet.
 */

import type { Chart, ChartColumn, ChartPlace, Plot } from "@document";
import type { GroupsTally, SampleTally } from "@engine";
import { m } from "@paraglide/messages";
import type { Heard } from "@renderer/charts";
import { wheelWay } from "@renderer/grid/metrics";
import { columnLabel } from "@renderer/grid/rows";
import { pressOf } from "@renderer/keys";
import type { Press } from "@renderer/keys";
import { Words, button, el } from "@renderer/shell/util";
import { bars, fitTips } from "./bars.ts";
import { blank, body, coverage, drawable, notNumbers, reading } from "./caption.ts";
import { belowZero, fitLabels, past, pie } from "./pie.ts";
import { dragged, nudged, placeOf, placed, stretched, tucks } from "./place.ts";
import type { Rect, Room } from "./place.ts";
import { fitAlong, sampled, scatter } from "./scatter.ts";
import { summary } from "./summary.ts";
import type { Summary } from "./summary.ts";
import { table } from "./table.ts";
import { NONE, Tooltip, targets } from "./tooltip.ts";

/** The × on the window's own close button, drawn in currentColor. */
const CROSS =
  '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">' +
  '<path d="M2 2l6 6M8 2l-6 6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
  "</svg>";

/** The table button's glyph, a header row over two columns, drawn in currentColor. */
const TABLE =
  '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">' +
  '<path d="M1.5 1.5h7v7h-7zM1.5 4.5h7M4.5 4.5v4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>' +
  "</svg>";

/** The grip's two diagonal strokes, drawn in currentColor. */
const GRIP =
  '<svg viewBox="0 0 12 12" width="12" height="12">' +
  '<path d="M10 3l-7 7M10 7l-3 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
  "</svg>";

/** A pointer's `button` for the left button, a finger or a pen's tip. */
const PRIMARY_BUTTON = 0;

/** What names something that scrolls inside a window, for the wheel to find it. */
const SCROLLS = ".chart-scrolls";

/**
 * How near its end a scroller counts as there, in px. At a zoom scrollTop is
 * fractional, and the sizes it adds up to are rounded, so an end can read short.
 */
const SCROLL_END_SLACK = 1;

/** What parts the caption's words. */
const SEP = " · ";

/** The key that puts the table in the plot's place, and the plot back. */
const TABLE_KEY = "t";

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
  /** Stands `box` over the other windows. */
  raise(box: HTMLElement): void;
  /** Gives the keys back to the grid. */
  leave(): void;
  /** Scrolls the sheet by a wheel turned over a window. */
  wheelBy(dx: number, dy: number, deltaMode: number): void;
  /** What chart `id` last heard from its source. */
  heard(id: string): Heard | undefined;
  /** Opens the sources panel on `source`, to point it at a file or connect its bucket. */
  repoint(source: string): void;
  /**
   * Shows `source`, and finds the first cell of `columns` that its tally could
   * not read as a number.
   */
  notNumbers(source: string, columns: readonly ChartColumn[]): void;
}

/** What a pointer does to a window: the rect it leaves `from`, moved `dx` and `dy` px. */
type Follow = (from: Rect, dx: number, dy: number, room: Room) => Rect;

/** A pointer that holds a window. */
interface Hold {
  /** The pointer's id. */
  pointer: number;
  /** The element that holds its capture. */
  zone: HTMLElement;
  /** Where it took hold, in the page's CSS px. */
  x: number;
  y: number;
  /** The rect the window stood at then. */
  from: Rect;
  /** What it does to the window. */
  follow: Follow;
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

/**
 * numbered gives the columns a plot reads numbers from: the one it sums, or a
 * scatter's x and y.
 */
function numbered(plot: Plot): ChartColumn[] {
  if (plot.t === "scatter") return [plot.x, plot.y];
  return plot.sum === undefined ? [] : [plot.sum];
}

/** tableKey says whether `press` is t alone, pressed once. */
function tableKey({ key, ctrl, alt, meta, repeat }: Press): boolean {
  return key === TABLE_KEY && !ctrl && !alt && !meta && !repeat;
}

/**
 * extra gives what the caption says after the counts, for the plot's kind:
 * what a scatter's sample leaves out, or how a pie counts the values past
 * those a tally keeps apart and the values at or below zero it leaves out.
 */
function extra(plot: Plot, tally: GroupsTally | SampleTally): string[] {
  if (plot.t === "scatter" && tally.t === "sample") return [sampled(tally)];
  if (plot.t === "pie" && tally.t === "groups") return [past(plot, tally), belowZero(plot, tally)];
  return [];
}

/** canGo says whether a scroller at `at` of `end` has room `delta`'s way. */
function canGo(delta: number, at: number, end: number): boolean {
  return delta > 0 ? end - at > SCROLL_END_SLACK : delta < 0 && at > 0;
}

/** hasRoom says whether `scroller` can still go `dx` along or `dy` down. */
function hasRoom(scroller: Element, dx: number, dy: number): boolean {
  const { scrollTop, scrollLeft, scrollHeight, scrollWidth, clientHeight, clientWidth } = scroller;
  return (
    canGo(dy, scrollTop, scrollHeight - clientHeight) ||
    canGo(dx, scrollLeft, scrollWidth - clientWidth)
  );
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
  /** The body between the head and the caption, which draws the chart. */
  private readonly plot = el("div", "chart-plot");
  /** How far the chart has read its source, under the head, while it reads. */
  private readonly track = el("div", "chart-coverage");
  /**
   * What the drawing says it shows, out of sight, which a screen reader hears
   * as its name: the app's words, the values from the file, marked as the
   * file's, and the count of the rest, each in a span of its own.
   */
  private readonly summary = el("div", "chart-summary");
  private readonly told: Record<keyof Summary, HTMLElement> = {
    said: el("span", "chart-summary-said"),
    values: el("bdi", "chart-summary-values from-file"),
    more: el("span", "chart-summary-more"),
  };
  /**
   * What the caption says of what the plot draws: the words before the
   * button, the · between them and it, the button, and the words after it.
   */
  private readonly said = el("span", "chart-said");
  private readonly before = el("span", "chart-said-before");
  private readonly dot = el("span", "chart-said-dot");
  private readonly after = el("span", "chart-said-after");
  /** The count of the cells that were not numbers, the button that finds them in the sheet. */
  private readonly find = button("chart-find", "", () =>
    this.stage.notNumbers(this.chart.source, numbered(this.chart.plot)),
  );
  /** The head's button that puts the table in the plot's place, pressed in while it stands there. */
  private readonly toggle = button("chart-head-button chart-table-toggle", "", () => this.flip());
  /** The words that stay whichever chart the window shows. */
  private readonly words = new Words();
  /** The box that says what the mark under the pointer is worth. */
  private readonly tip: Tooltip;
  /** The pointer that holds the window, while one does. */
  private hold: Hold | undefined;
  /** The frame the next draw of the plot waits for, or 0. */
  private frame = 0;
  /** Whether the table stands in the plot's place. */
  private tabled = false;
  /** The table of the tally and title it holds, kept while they stand, so a repaint keeps its scroll. */
  private table: { of: GroupsTally | SampleTally; title: string; box: HTMLElement } | undefined;

  constructor(
    /** The chart the window shows, as the layer last said. */
    private chart: Chart,
    private readonly stage: Stage,
  ) {
    const id = `chart-${++made}`;
    const caption = el("div", "chart-caption");
    caption.id = `${id}-caption`;
    this.title.id = `${id}-title`;
    this.summary.id = `${id}-summary`;
    this.summary.hidden = true;
    this.tip = new Tooltip(this.plot, this.box, `${id}-tip`);
    this.summary.append(this.told.said, " ", this.told.values, " ", this.told.more);

    const x = el("button", "round-x chart-close");
    x.type = "button";
    x.innerHTML = CROSS;
    this.words.attr(x, "aria-label", m.chart_remove_aria);
    this.toggle.innerHTML = TABLE;
    this.toggle.setAttribute("aria-pressed", "false");
    this.words.attr(this.toggle, "aria-label", m.chart_table_aria);

    const head = el("div", "col-head chart-head");
    head.append(this.title, this.toggle, x);
    head.addEventListener("pointerdown", (e) => {
      const onButton = e.target instanceof Element && e.target.closest("button") !== null;
      if (!onButton) this.take(e, head, dragged);
    });

    const grip = el("span", "chart-grip");
    grip.innerHTML = GRIP;
    grip.setAttribute("aria-hidden", "true");
    grip.addEventListener("pointerdown", (e) => this.take(e, grip, stretched));
    // The button shows once a tally counts cells that were not numbers.
    this.find.hidden = true;
    this.said.append(this.before, this.dot, this.find, this.after);
    caption.append(this.said, grip);

    const right = el("div", "chart-edge chart-edge-right");
    right.addEventListener("pointerdown", (e) => {
      this.take(e, right, (from, dx, _dy, room) => stretched(from, dx, 0, room));
    });
    const foot = el("div", "chart-edge chart-edge-foot");
    foot.addEventListener("pointerdown", (e) => {
      this.take(e, foot, (from, _dx, dy, room) => stretched(from, 0, dy, room));
    });

    this.box.tabIndex = -1;
    this.box.setAttribute("role", "group");
    this.box.setAttribute("aria-labelledby", this.title.id);
    this.box.setAttribute("aria-describedby", caption.id);
    this.words.attr(this.box, "aria-roledescription", m.chart_role);
    this.box.append(head, this.plot, this.tip.box, this.summary, this.track, caption, right, foot);
    // Whatever resizes the window, the plot draws again in the frame it lands in.
    new ResizeObserver(() => this.paint()).observe(this.plot);
    // A pointer's capture sends these to the zone it pressed, and they bubble here.
    this.box.addEventListener("pointermove", (e) => this.follow(e));
    this.box.addEventListener("pointerup", (e) => this.drop(e));
    this.box.addEventListener("pointercancel", (e) => this.lost(e));
    this.box.addEventListener("lostpointercapture", (e) => this.lost(e));
    this.box.addEventListener("keydown", (e) => this.key(e));
    this.box.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    this.box.addEventListener("focusin", () => stage.raise(this.box));
  }

  /**
   * show writes what `chart` says in the head, after `source` if it has one,
   * and draws the plot again.
   */
  show(chart: Chart, source: string | undefined): void {
    this.chart = chart;
    const title = el("bdi", "", this.named());
    if (source === undefined) this.title.replaceChildren(title);
    else this.title.replaceChildren(el("bdi", "from-file", source), " · ", title);
    this.title.title = this.title.textContent;
    this.title.classList.toggle("from-file", chart.title !== "");
    this.redraw();
  }

  /** stand puts the window at `rect`, unless a pointer holds it. */
  stand(rect: Rect): void {
    if (this.hold === undefined) standAt(this.box, rect);
  }

  /**
   * relabel writes the window's own words in the current language, and draws
   * the plot again, whose words, table and summary follow the language too.
   */
  relabel(): void {
    this.words.write();
    this.table = undefined;
    this.redraw();
  }

  /** redraw draws the plot again on the next frame. Repeated calls coalesce. */
  redraw(): void {
    if (this.frame !== 0) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  /**
   * paint draws what the chart last heard, or puts its table in the plot's
   * place. A complete tally stays drawn while the next one is read, and a
   * first one draws as it comes. The caption says how much of its source the
   * chart has read and what the tally left out, then what the plot's kind
   * says. The track under the head shows how far the chart has read, while it
   * reads, and a chart with nothing to draw says why in the plot's place.
   */
  private paint(): void {
    const heard = this.stage.heard(this.chart.id);
    const tally = drawable(heard);
    const { plot } = this.chart;
    const latest = heard?.latest;
    const named = this.summarise(heard);
    if (tally === undefined) this.fill(false, ...this.state(heard));
    else if (this.tabled) this.tabulate(tally);
    else this.draw(plot, tally, named);
    const after = tally === undefined ? [] : extra(plot, tally);
    this.say([coverage(latest), blank(latest)], notNumbers(latest), after);
    const read = reading(heard);
    this.track.hidden = read === undefined;
    this.track.style.setProperty("--read", `${read ?? 0}`);
  }

  /**
   * draw draws `tally` as `plot` reads it, at the plot's height, as an image
   * `named` names, fits the values, the x axis or the labels to the plot
   * once they stand in it, and gives the box the marks where the fit leaves
   * them.
   */
  private draw(plot: Plot, tally: GroupsTally | SampleTally, named: string): void {
    let drawn: HTMLElement | undefined;
    if (plot.t === "bars" && tally.t === "groups") {
      drawn = this.place(bars(plot, tally, this.plot.clientHeight), named);
      fitTips(drawn);
    } else if (plot.t === "scatter" && tally.t === "sample") {
      drawn = this.place(scatter(tally), named);
      fitAlong(drawn, tally);
    } else if (plot.t === "pie" && tally.t === "groups") {
      drawn = this.place(pie(plot, tally), named);
      fitLabels(drawn);
    }
    if (drawn !== undefined) this.tip.show(targets(plot, tally, drawn));
  }

  /** place puts `drawn` in the plot as an image, named by what `named` names, and gives it back. */
  private place(drawn: HTMLElement, named: string): HTMLElement {
    drawn.setAttribute("role", "img");
    drawn.setAttribute("aria-labelledby", named);
    this.fill(true, drawn);
    return drawn;
  }

  /**
   * tabulate puts the table of `tally` in the plot's place. The table stands
   * while its tally and its title do, so a repaint of the same leaves it as
   * it is, scrolled where it was, and a new tally, a new title or a relabel
   * builds it again.
   */
  private tabulate(tally: GroupsTally | SampleTally): void {
    const title = this.named();
    if (this.table?.of !== tally || this.table.title !== title) {
      const called = el("bdi", this.chart.title === "" ? "" : "from-file", title);
      this.table = { of: tally, title, box: table(this.chart.plot, tally, called) };
    }
    if (this.plot.firstChild !== this.table.box) this.fill(false, this.table.box);
  }

  /** flip puts the table in the plot's place, or the plot back, and the button says which. */
  private flip(): void {
    this.tabled = !this.tabled;
    this.toggle.setAttribute("aria-pressed", `${this.tabled}`);
    this.redraw();
  }

  /**
   * summarise writes what the drawing says it shows, from the last complete
   * tally, so a partial never changes it, and gives the id of what names the
   * drawing: the summary, or the head's title until a tally completes. Each
   * paint writes it again, so a relabel and a new title reach it.
   */
  private summarise(heard: Heard | undefined): string {
    const complete = heard?.complete;
    const told =
      heard === undefined || complete === undefined
        ? undefined
        : summary(this.named(), heard.name, this.chart.plot, complete);
    for (const part of ["said", "values", "more"] as const) {
      this.told[part].textContent = told?.[part] ?? "";
    }
    return told === undefined ? this.title.id : this.summary.id;
  }

  /** named gives what the head calls the chart: the person's title, or the one its plot makes. */
  private named(): string {
    return this.chart.title === "" ? madeTitle(this.chart.plot) : this.chart.title;
  }

  /**
   * fill puts `shown` in the plot's place. What stood there goes, and the keys
   * it held come to the window, as the find button's do, so a repaint never
   * leaves them to the page. A plot that goes on drawing keeps them. Anything
   * but a `drawing` leaves the box no mark to stand by, and Tab passes the
   * plot by.
   */
  private fill(drawing: boolean, ...shown: Node[]): void {
    const held = document.activeElement;
    const kept = drawing && held === this.plot;
    if (!kept && this.plot.contains(held)) this.box.focus({ preventScroll: true });
    this.plot.replaceChildren(...shown);
    // Tab reaches a drawing after the head's buttons, for the keys to step its marks.
    if (drawing) {
      this.plot.tabIndex = 0;
    } else {
      this.plot.removeAttribute("tabindex");
      this.tip.show(NONE);
    }
  }

  /**
   * say writes the caption: the words `before` the button, `count`, the cells
   * that were not numbers, as the button, and the words `after` it, those that
   * say something, with · between them, and the whole in its title, as a
   * narrow window cuts them. The button is the one element whichever words
   * stand around it, so a repaint never takes the keys from it; a count of
   * none hides it, and gives the keys it held to the window.
   */
  private say(before: readonly string[], count: string, after: readonly string[]): void {
    const lead = before.filter((part) => part !== "").join(SEP);
    const trail = after.filter((part) => part !== "").join(SEP);
    if (count === "" && document.activeElement === this.find) {
      this.box.focus({ preventScroll: true });
    }
    this.find.hidden = count === "";
    this.find.textContent = count;
    this.before.textContent = lead;
    this.dot.textContent = lead !== "" && count !== "" ? SEP : "";
    this.after.textContent = trail !== "" && (lead !== "" || count !== "") ? SEP + trail : trail;
    this.said.title = this.said.textContent;
  }

  /**
   * state gives what the plot shows in place of a chart it cannot draw, with
   * the button of any action that mends it, or nothing for one that has gone.
   */
  private state(heard: Heard | undefined): HTMLElement[] {
    const said = heard === undefined ? undefined : body(this.chart.plot, heard);
    if (said === undefined) return [];
    const box = el("div", "chart-state");
    box.append(el("bdi", "", said.words));
    if (said.action !== undefined) {
      box.append(button("", said.action, () => this.stage.repoint(this.chart.source)));
    }
    return [box];
  }

  /**
   * take answers a press on `zone`, which holds the pointer from then on. The
   * press commits an open cell, through its blur. It stays uncancelled, so its
   * mousedown reaches what closes an open menu or form. A tucked window takes
   * the keys and stays, as its rect has no place.
   */
  private take(e: PointerEvent, zone: HTMLElement, follow: Follow): void {
    if (e.button !== PRIMARY_BUTTON || this.hold !== undefined) return;
    this.box.focus({ preventScroll: true });
    const room = this.stage.room();
    if (tucks(room)) return;
    zone.setPointerCapture(e.pointerId);
    const from = placed(this.chart.place, room);
    this.hold = { pointer: e.pointerId, zone, x: e.clientX, y: e.clientY, from, follow };
  }

  /** follow stands the window where its pointer has gone, in the room as it is now. */
  private follow(e: PointerEvent): void {
    const hold = this.hold;
    if (hold?.pointer !== e.pointerId) return;
    hold.to = hold.follow(hold.from, e.clientX - hold.x, e.clientY - hold.y, this.stage.room());
    standAt(this.box, hold.to);
  }

  /** drop stores where the pointer left the window. A click stores nothing. */
  private drop(e: PointerEvent): void {
    if (this.hold?.pointer !== e.pointerId) return;
    const { to } = this.hold;
    this.hold = undefined;
    if (to !== undefined) this.store(to, this.stage.room());
    this.stage.draw();
  }

  /**
   * lost answers a pointer taken away with no drop, which puts the window back.
   * A finger's capture starts on what it pressed, which can sit inside the zone,
   * so only the zone's own loss counts: the first is the move to the zone.
   */
  private lost(e: PointerEvent): void {
    if (this.hold?.pointer === e.pointerId && e.target === this.hold.zone) this.putBack();
  }

  /** putBack lets go of the pointer's rect, so the window draws from its place. */
  private putBack(): void {
    this.hold = undefined;
    this.stage.draw();
  }

  /** store keeps `rect` as the chart's place. A tucked window's rect has none. */
  private store(rect: Rect, room: Room): void {
    if (!tucks(room)) this.stage.move(this.chart.id, placeOf(rect, room, this.chart.place));
  }

  /**
   * wheel leaves a turn to what scrolls inside the window while it has room, as
   * the browser scrolls it, and hands any other to the sheet behind the window.
   */
  private wheel(e: WheelEvent): void {
    if (e.ctrlKey) return; // Ctrl+wheel is zoom
    const { dx, dy } = wheelWay(e.deltaX, e.deltaY, e.shiftKey);
    const inner = e.target instanceof Element ? e.target.closest(SCROLLS) : null;
    if (inner !== null && hasRoom(inner, dx, dy)) return;
    e.preventDefault();
    this.stage.wheelBy(dx, dy, e.deltaMode);
  }

  /**
   * key answers Escape, t and the arrows, and leaves any other key to the
   * shell. An arrow in the plot steps the cursor through its marks, and one
   * in the table scrolls it, as each has the keys then.
   */
  private key(e: KeyboardEvent): void {
    const press = pressOf(e);
    if (e.key === "Escape") this.escape();
    else if (tableKey(press)) this.flip();
    else if (!this.arrow(press, e.target)) return;
    e.preventDefault();
    e.stopPropagation();
  }

  /**
   * arrow gives `press`, from `at`, to the cursor in the plot, or to the
   * window's place where the cursor does not take it, and returns whether
   * either stepped.
   */
  private arrow(press: Press, at: EventTarget | null): boolean {
    if (at === this.plot && this.tip.step(press)) return true;
    const inTable = at instanceof Element && at.closest(SCROLLS) !== null;
    return !inTable && this.nudge(press);
  }

  /** escape puts back what a pointer holds, or else gives the grid the keys. */
  private escape(): void {
    if (this.hold === undefined) this.stage.leave();
    else this.putBack();
  }

  /**
   * nudge stands the window where `press` steps it, and returns whether it is
   * an arrow. While a pointer holds the window an arrow does nothing, so Escape
   * still puts it back where the pointer found it.
   */
  private nudge(press: Press): boolean {
    const room = this.stage.room();
    const to = nudged(placed(this.chart.place, room), press, room);
    if (to === undefined) return false;
    if (this.hold === undefined) this.store(to, room);
    this.stage.draw();
    return true;
  }
}
