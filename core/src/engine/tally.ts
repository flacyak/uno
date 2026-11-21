/**
 * @fileoverview A view's charts, each folded over the rows read so far.
 *
 * A pass over the view's blocks feeds every chart in order, so a chart's
 * fold holds every row before the first block it lacks, an edit moves a
 * fold by the one row it changed, and an append takes over the folds of
 * the rows it kept. A chart reads the columns its plot names, found again
 * by header where the file moved them, with each column's decimal mark.
 */

import type { Chart, Plot } from '@document';
import type { Mark } from '@num';
import type { Said } from '@said';
import { isCount, isRecord } from '@tally';
import type { Per, TimeLevel } from '@tally';
import { FOLDERS, folderOf } from './fold/index.ts';
import type { Block, Folder, Folders } from './fold/index.ts';
import type { Tally } from './protocol.ts';

export { placeOf } from './fold/index.ts';
export type { Block } from './fold/index.ts';

/** How far one chart's fold has got. */
interface Folding {
  /** The plot the fold reads, which its tally names. */
  plot: Plot;
  /** Rows folded: every row before the first block it lacks. */
  rows: number;
  /**
   * Rows folded ahead of `rows`, as [from, end): the blocks the index
   * completed while the pass behind them was still reading, which join
   * `rows` once it reaches them.
   */
  ahead: [number, number] | undefined;
  /**
   * Whether the chart has heard its last tally: the complete one, or that
   * its source could not be read.
   */
  done: boolean;
}

/** How far a fold has got, and its folder. */
type Fold = Pick<Folding, 'rows' | 'ahead'> & { folder: Folder };

/**
 * One chart's fold, through the folder of its kind, over the plot's columns
 * where the view's headers put them, and the fold its folder fills behind it.
 */
interface Tallying extends Folding {
  folder: Folder;
  behind?: Fold;
}

/**
 * SavedChart is what a save keeps of a chart's fold: which fold its columns
 * make, the rows it holds, and the fold, with the marks it read them with.
 */
export interface SavedChart {
  key: string;
  rows: number;
  ahead?: [number, number];
  fold: object;
}

/**
 * Tallies folds a view's charts. A chart is attached to be folded, and is
 * pending until it hears its complete tally.
 */
export class Tallies {
  /** Each kind of chart's folder. */
  private readonly folders: Folders;
  private readonly charts = new Map<string, Tallying>();
  /** The folds a save kept of charts not attached since, by chart id. */
  private kept: Readonly<Record<string, unknown>> = {};
  /** The rows the index a save kept holds, which no kept fold passes. */
  private readable = 0;
  /** The last block of that index, which a grown file reads again. */
  private gone: { block: number; rows: Block } | undefined;
  /** Each column's decimal mark, by place, as `remark` was last told. */
  private marks: readonly Mark[] = [];

  constructor(folders: Folders = FOLDERS) {
    this.folders = folders;
  }

  /**
   * attach folds `chart`, keeping the fold of the chart with its id when it
   * reads the same columns the same way, or returns the header of a column
   * the view has not, which leaves the chart with no fold.
   */
  attach(chart: Chart, headers: readonly string[]): string | undefined {
    const { id, plot } = chart;
    const folder = folderOf(this.folders, plot.t, plot, headers, this.marks);
    if (typeof folder === 'string') {
      this.charts.delete(id);
      return folder;
    }
    const behind = behindOf(folder);
    const t: Tallying = { ...unfolded(), plot, folder, behind };
    const was = this.charts.get(id) ?? this.restored(id, t);
    // A fold kept reads the same columns the same way, as `key` names them.
    const keeps = (f: Folder | undefined, key: string | undefined) =>
      key !== undefined && f?.key === key && f.readsWith(this.marks);
    // A chart keeps its fold, or the fold that took its place from behind it.
    const kept =
      keeps(was?.folder, folder.key) || keeps(was?.folder, folder.behind?.key);
    if (was !== undefined && kept) {
      was.plot = plot;
      was.done = false;
      this.charts.set(id, was);
      return undefined;
    }
    // A fold behind of the same columns goes on from where it stood.
    if (keeps(was?.behind?.folder, folder.behind?.key)) t.behind = was?.behind;
    this.charts.set(id, t);
    return undefined;
  }

  /**
   * restore keeps `saved`, the folds a save kept by chart id, for the charts
   * attach finds them for, over an index a save kept of `readable` rows. Of
   * a file grown since, each fold gives back the rows of `gone`, the last
   * block, which the view reads again with the rows that follow.
   */
  restore(
    saved: Readonly<Record<string, unknown>>,
    readable: number,
    gone?: { block: number; rows: Block },
  ): void {
    this.kept = saved;
    this.readable = readable;
    this.gone = gone;
  }

  /**
   * restored is `t` with the fold the save kept of the chart with `id`,
   * where it is of the same columns and holds no row past the index, which
   * attach keeps where it reads them with the same marks.
   */
  private restored(id: string, t: Tallying): Tallying | undefined {
    const saved = this.kept[id];
    if (!isRecord(saved)) return undefined;
    // A fold behind the chart's own, saved in its place, takes it again.
    const key = saved['key'];
    const into = [t.folder, t.behind?.folder].find((f) => f?.key === key);
    if (into === undefined) return undefined;
    const { rows, ahead, fold } = saved;
    const run: unknown[] = Array.isArray(ahead) ? ahead : [rows, rows];
    const [from, end] = run;
    if (!isCount(rows) || !isCount(from) || !isCount(end)) return undefined;
    // A run folded ahead starts past the rows folded, and none passes the
    // index.
    const ran = from > rows;
    if (ran !== Array.isArray(ahead) || from > end || end > this.readable)
      return undefined;
    const on: Pick<Folding, 'rows' | 'ahead'> = {
      rows,
      ahead: ran ? [from, end] : undefined,
    };
    const folder = into.restored(fold);
    const behind = into === t.folder ? t.behind : undefined;
    return folder && this.givenBack({ ...t, ...on, folder, behind });
  }

  /** givenBack is `t` without the rows of the block restore said is gone. */
  private givenBack(t: Tallying): Tallying {
    if (this.gone !== undefined) giveBack(t, this.gone.block, this.gone.rows);
    return t;
  }

  /**
   * remark takes each column's decimal mark, by place, and starts the fold
   * of each chart that reads a column with another mark again from its
   * first row, with the mark now. It says whether any chart does.
   */
  remark(marks: readonly Mark[]): boolean {
    this.marks = marks;
    let refolded = false;
    for (const [id, t] of this.charts) {
      if (t.folder.readsWith(marks)) continue;
      this.charts.set(id, fresh(t, marks));
      refolded = true;
    }
    return refolded;
  }

  /** detach stops folding the chart with `id`. */
  detach(id: string): void {
    this.charts.delete(id);
  }

  /**
   * saved is the fold of each chart that holds any row, by the chart's id,
   * as a save keeps it. A fold an edit left to fold again when it opens is
   * left out.
   */
  saved(): Record<string, SavedChart> {
    const saved: Record<string, SavedChart> = {};
    for (const [id, t] of this.charts) {
      if (t.rows === 0 && t.ahead === undefined) continue;
      const fold = t.folder.saved();
      if (fold === undefined) continue;
      const { rows, ahead } = t;
      saved[id] = { key: t.folder.key, rows, ahead, fold };
    }
    return saved;
  }

  /** batch is the chart with `id`'s batch at `per` from `offset`, if any. */
  batch(id: string, per: Per, offset: number): TimeLevel | undefined {
    return this.charts.get(id)?.folder.batch?.(per, offset);
  }

  /** How many charts are attached. */
  get size(): number {
    return this.charts.size;
  }

  /**
   * feeding is the folds a pass feeds: each pending chart's own, or once every
   * chart has heard its complete tally, the folds behind them.
   */
  private feeding(): Fold[] {
    const own = [...this.charts.values()].filter((t) => !t.done);
    if (own.length > 0) return own;
    return [...this.charts.values()].flatMap((t) => t.behind ?? []);
  }

  /** from is the first row a fold the pass feeds lacks, or undefined when none does. */
  from(): number | undefined {
    let from: number | undefined;
    for (const t of this.feeding()) {
      if (from === undefined || t.rows < from) from = t.rows;
    }
    return from;
  }

  /**
   * wants says whether a fold the pass feeds ends at `from`, so the block
   * there must be read for it.
   */
  wants(from: number): boolean {
    return this.feeding().some((t) => t.rows === from);
  }

  /**
   * lacks is where the rows that pending charts whose fold ends at `from`
   * lack from there on end: at the run each folded ahead, or past the last
   * row. `from` itself where no pending chart's fold ends at `from`.
   */
  lacks(from: number): number {
    let end = from;
    for (const t of this.feeding()) {
      if (t.rows !== from) continue;
      end = Math.max(end, t.ahead?.[0] ?? Number.POSITIVE_INFINITY);
    }
    return end;
  }

  /**
   * fold adds `block`, the rows from `from` to `end`, to every pending chart
   * that can take it: as its next block, or ahead of the pass behind it.
   * `shown` returns what a column of the block shows, by row.
   */
  fold(
    block: number,
    from: number,
    end: number,
    shown: (col: number) => (row: number) => string,
  ): void {
    const feeding = this.feeding();
    for (const t of feeding) {
      if (!takes(t, from)) continue;
      t.folder.fold(block, { from, end, shown });
      took(t, from, end);
    }
    // A fold behind that cannot hold every row in place can take no fold's place, so it stops.
    for (const t of this.charts.values()) {
      const { behind } = t;
      const fed = behind !== undefined && feeding.includes(behind);
      if (fed && behind.folder.whole?.() === false) t.behind = undefined;
    }
  }

  /**
   * cell moves each chart that has folded `row` of `block` and reads a
   * column the row shows otherwise now, by that one row: out as it showed
   * `before` the edit, and back in as it shows `after`. The ids of the
   * charts moved are returned, for mend.
   */
  cell(
    block: number,
    row: number,
    before: readonly string[],
    after: readonly string[],
  ): string[] {
    const shows = (col: number) => (before[col] ?? '') !== (after[col] ?? '');
    const moved: string[] = [];
    for (const [id, t] of this.charts) {
      if (!t.folder.cols.some(shows)) continue;
      const both = t.behind === undefined ? [t] : [t, t.behind];
      const folds = both.filter((f) => holds(f, row));
      for (const f of folds) f.folder.move(block, row, before, after);
      if (folds.length > 0) moved.push(id);
    }
    return moved;
  }

  /**
   * mend reads again, through `read`, each block the edit left a fold among
   * `moved` inexact over, such as a scatter's block whose least or most the
   * row sat on, and folds it alone. Then each chart of `moved` is pending
   * again, so it hears its tally with the row moved. A read that fails
   * leaves them pending too, so the caller can say unread to them.
   */
  async mend(
    moved: readonly string[],
    read: (block: number) => Promise<Block>,
  ): Promise<void> {
    const charts = moved.flatMap((id) => this.charts.get(id) ?? []);
    try {
      for (const t of charts) await t.folder.mend(read);
    } finally {
      for (const t of charts) t.done = false;
    }
  }

  /**
   * adopt takes over the folds of `was`'s charts for a view whose index
   * kept every block `was` read but `block`, its last, whose rows `last`
   * holds, and which the view reads again with the rows that follow. A fold
   * that holds the block gives its rows back, so every fold holds the kept
   * rows alone, and each chart is pending, to hear the rows that follow;
   * `was` is left with no chart. attach keeps a fold adopted while the
   * chart reads the same columns.
   */
  adopt(was: Tallies, block: number, last: Block): void {
    for (const [id, t] of was.charts) {
      giveBack(t, block, last);
      t.done = false;
      this.charts.set(id, t);
    }
    // `was`, alive until it is closed, folds nothing more into these folds.
    was.charts.clear();
  }

  /**
   * reclaim takes the charts `now` adopted from this view back, each with
   * nothing folded, for an open of `now` that failed after adopt: a fold may
   * hold rows of the blocks `now` read again, which this view has not.
   */
  reclaim(now: Tallies): void {
    for (const [id, t] of now.charts) {
      this.charts.set(id, fresh(t, this.marks));
    }
    now.charts.clear();
  }

  /**
   * refold starts the fold of each chart that reads any of `cols` again
   * from its first row, for an edit that changed every row of them, and
   * says whether any chart does.
   */
  refold(cols: ReadonlySet<number>): boolean {
    let refolded = false;
    for (const [id, t] of this.charts) {
      if (!t.folder.cols.some((col) => cols.has(col))) continue;
      this.charts.set(id, fresh(t, this.marks));
      refolded = true;
    }
    return refolded;
  }

  /**
   * read returns each pending chart's tally over `total` rows, complete once
   * the index is, `indexed`, and the chart has folded every row. A complete
   * one is the chart's last, until it is attached again or moved.
   */
  read(total: number, indexed: boolean): Array<[string, Tally]> {
    const read: Array<[string, Tally]> = [];
    for (const [id, was] of this.charts) {
      const t = filled(was, total, indexed);
      this.charts.set(id, t);
      if (t.done) continue;
      const ahead = t.ahead === undefined ? 0 : t.ahead[1] - t.ahead[0];
      const complete = indexed && t.rows === total;
      const coverage = { rows: t.rows + ahead, total, complete };
      read.push([id, t.folder.tally(t.plot, coverage)]);
      t.done = complete;
    }
    return read;
  }

  /**
   * unread returns, for each pending chart, or for each pending one of
   * `ids`, that its source could not be read, and stops every fold behind.
   */
  unread(said: Said, ids?: readonly string[]): Array<[string, Tally]> {
    const unread: Array<[string, Tally]> = [];
    for (const id of ids ?? this.charts.keys()) {
      const t = this.charts.get(id);
      // A source that cannot be read leaves nothing to fill behind a fold.
      if (t !== undefined) t.behind = undefined;
      if (t === undefined || t.done) continue;
      unread.push([id, { t: 'unread', plot: t.plot, said }]);
      t.done = true;
    }
    return unread;
  }
}

/** unfolded is how far a fold has got before any row: nothing, pending. */
function unfolded(): Omit<Folding, 'plot'> {
  return { rows: 0, ahead: undefined, done: false };
}

/**
 * filled is a chart's fold, `t`, or the fold behind it in its place once that
 * has folded every one of `total` rows, so its tally is the one heard.
 */
function filled(t: Tallying, total: number, indexed: boolean): Tallying {
  const { behind } = t;
  const done =
    indexed &&
    behind?.rows === total &&
    behind.ahead === undefined &&
    behind.folder.whole?.() !== false;
  return behind === undefined || !done
    ? t
    : { ...t, ...behind, behind: undefined };
}

/** behindOf is the fold `folder` fills behind it, with nothing folded, if any. */
function behindOf(folder: Folder): Fold | undefined {
  return folder.behind && { rows: 0, ahead: undefined, folder: folder.behind };
}

/** fresh is `t` with nothing folded, pending again, read with `marks`. */
function fresh(t: Tallying, marks: readonly Mark[]): Tallying {
  const folder = t.folder.again(marks);
  return { ...t, ...unfolded(), folder, behind: behindOf(folder) };
}

/**
 * takes says whether the block from `from` is one `t` can fold: its next,
 * the next of the run it folded ahead, or the first of that run.
 */
function takes(t: Fold, from: number): boolean {
  if (t.rows === from) return true;
  return t.ahead === undefined ? from > t.rows : t.ahead[1] === from;
}

/**
 * took records that `t` folded the rows from `from` to `end`, and joins the
 * run it folded ahead once its rows reach it.
 */
function took(t: Fold, from: number, end: number): void {
  if (t.rows !== from) {
    t.ahead = t.ahead === undefined ? [from, end] : [t.ahead[0], end];
    return;
  }
  t.rows = end;
  if (t.ahead?.[0] === end) {
    t.rows = t.ahead[1];
    t.ahead = undefined;
  }
}

/**
 * holds says whether `t` has folded `row`: before its rows, or in the run
 * it folded ahead of them.
 */
function holds(t: Fold, row: number): boolean {
  if (row < t.rows) return true;
  return t.ahead !== undefined && t.ahead[0] <= row && row < t.ahead[1];
}

/**
 * giveBack takes the rows of `block`, `last`, out of `t`'s fold where it
 * holds them, for a view that reads the block again with the rows that
 * follow, so the fold holds the rows before it alone.
 */
function giveBack(t: Tallying, block: number, last: Block): void {
  if (t.behind !== undefined) givenBackBy(t.behind, block, last);
  givenBackBy(t, block, last);
}

/** givenBackBy takes the rows of `block`, `last`, out of fold `t` where it holds them. */
function givenBackBy(t: Fold, block: number, last: Block): void {
  const kept = last.from;
  // A fold takes blocks whole, so one that holds the block's first row
  // holds the block.
  if (holds(t, kept)) t.folder.unfold(block, last);
  t.rows = Math.min(t.rows, kept);
  if (t.ahead !== undefined) {
    const [from, end] = t.ahead;
    t.ahead = from < kept ? [from, Math.min(end, kept)] : undefined;
  }
}
