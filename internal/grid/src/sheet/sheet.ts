// Package sheet holds one in-memory table per workspace. It imports nothing
// from the packages above it, which is what lets it be tested with no display
// attached.

import { formatFloat, roundSignificant } from "../go/index.ts";
import type { Formula, Row } from "../formula/index.ts";
import { Graph, evaluate, parse as parseFormula } from "../formula/index.ts";
import { render as renderNotation, supported as notationSupported } from "../notation/index.ts";
import type { Program } from "../program/index.ts";
import {
  apply as applyProgram,
  parse as parseProgram,
  text as programText,
} from "../program/index.ts";
import type { Edit } from "./edit.ts";
import { NO_ROW, Op, editEquals } from "./edit.ts";
import type { Kind } from "./kind.ts";
import { inferKind } from "./kind.ts";

/**
 * ERR_CELL is what a bound column shows where its expression could not read a
 * row: a divisor of zero, a cell holding "N/A".
 *
 * It is short because it has to fit a column sized for numbers, and it is
 * unmistakable because the alternative -- an empty cell -- reads as missing
 * data rather than as a failure. The reason is said in the editor, beside the
 * expression, where there is room for it.
 */
export const ERR_CELL = "#ERR";

/** Column pairs a header with the kind inferred from the values beneath it. */
export interface Column {
  header: string;
  /** Inferred at load; never stored in the file. */
  kind: Kind;
  /**
   * Marks a column that looks numeric but does not parse cleanly, such as one
   * whose thousands separators break half its values. It is the condition the
   * recogniser acts on.
   */
  flagged: boolean;
}

/**
 * formatValue renders a computed number the way a spreadsheet does.
 *
 * The rounding is the point. (40.00 - 31.20) / 40.00 is 0.21999999999999997 in
 * binary floating point, and a column of those is arithmetic showing its
 * working. Ten significant digits is far more precision than a cell displays
 * and far less than float64 noise, so it removes the artefact without removing
 * an answer. The second pass turns the result back into plain notation, since a
 * spreadsheet column showing 1.234567890e+12 has helped nobody.
 */
export function formatValue(v: number): string {
  return formatFloat(roundSignificant(v, 10));
}

/**
 * Sheet is the one copy of the data in memory. `ingest` builds it at load, the
 * grid reads it every frame, and the recorded operations are the single door
 * through which it changes.
 */
export class Sheet {
  readonly columns: Column[];
  /** How `ingest` read these bytes, for the status bar to show verbatim. It is
   * an opaque label here on purpose: `ingest` owns the wording, so `sheet` still
   * knows nothing about delimiters or encodings. */
  source = "";

  private readonly rowData: string[][];
  private readonly log: Edit[] = [];

  /**
   * What `display` hands out where something has filled it in: a column a
   * formula is bound to, and a cell holding notation.
   *
   * Indexed by column and undefined for a column nothing computes, so the
   * common case costs one bounds check and no allocation on the per-frame path.
   * An array and not a map because `display` runs about two hundred times a
   * frame, and hashing a key that many times to answer "no" for most of them is
   * work the grid does not have to do.
   */
  private readonly computed: Array<string[] | undefined>;

  /**
   * The expression each computed column resolves to, and what they depend on.
   *
   * Both are rebuilt by replaying the log, so neither is written to the file:
   * raw plus the log is the whole truth of a workspace, and a second copy of a
   * binding is a second thing to keep in step.
   */
  private readonly bound = new Map<number, Formula>();
  private readonly graph = new Graph();

  /**
   * Builds a sheet from a header row and the data rows beneath it, inferring
   * each column's kind as it goes.
   *
   * A row longer than the header contributes no column: the header decides the
   * shape, and `raw` tolerates the overhang.
   */
  constructor(
    readonly name: string,
    header: string[],
    rows: string[][],
  ) {
    this.rowData = rows;
    this.columns = header.map((h) => ({ header: h, kind: "text" as Kind, flagged: false }));
    this.computed = header.map(() => undefined);
    for (let i = 0; i < header.length; i++) this.inferKindOf(i);
  }

  rows(): number {
    return this.rowData.length;
  }

  cols(): number {
    return this.columns.length;
  }

  /**
   * raw is what the cell stores. The log records it, undo restores it, and the
   * recogniser reads it, because all three are about the value a person put
   * there rather than the one they are being shown.
   *
   * An absent cell is empty rather than an error: short rows are normal in real
   * exports, and returning "" is what lets the table skip bounds checks while
   * scrolling.
   */
  raw(row: number, col: number): string {
    const r = this.rowData[row];
    if (r === undefined || row < 0) return "";
    if (col < 0) return "";
    return r[col] ?? "";
  }

  /**
   * display is what the cell shows, and what the grid binds to. It is called
   * once per visible cell on every scroll frame, so it reads and returns:
   * whatever fills it in does so when an edit lands, never when a cell is read.
   *
   * The body is a cache read and nothing else. Recalculation fills it when an
   * edit lands, walking the dependency graph in order; a notation cell fills
   * its own entry when it is authored. Evaluating here instead would put an
   * expression tree walk on the scroll path, which is the exact mistake this
   * seam exists to prevent.
   */
  display(row: number, col: number): string {
    if (col >= 0 && col < this.computed.length) {
      const vals = this.computed[col];
      if (vals !== undefined && row >= 0 && row < vals.length) {
        const v = vals[row];
        if (v !== undefined && v !== "") return v;
      }
    }
    return this.raw(row, col);
  }

  // ------------------------------------------------------------ the log

  /**
   * set applies an edit and records it. It is the only way the grid changes a
   * single value, so the log can never fall behind the data it describes.
   *
   * An out-of-range cell cannot come from the grid, which only offers cells
   * that exist, so it means a log that does not belong to these bytes. That is
   * worth a failure rather than a silent no-op.
   */
  set(row: number, col: number, v: string): void {
    this.record({ seq: 0, op: Op.Set, row, col, was: this.raw(row, col), now: v });
  }

  /**
   * apply runs a program over every value in a column and records it as one
   * operation.
   *
   * It is the door a pattern proposal comes through, and the reason the log
   * stays proportional to what a person did rather than to how much data they
   * did it to: 3,149 cells change and one line is written.
   */
  apply(col: number, p: Program): void {
    this.record({ seq: 0, op: Op.Apply, row: NO_ROW, col, now: programText(p) });
  }

  /**
   * note puts notation in one cell: the person types markdown and the cell
   * shows the symbols it describes.
   *
   * It is a different operation from `set` because it stores a different thing.
   * A set cell holds the value it shows. A notation cell holds a source, and
   * what it shows is derived from that source, which is the same relationship a
   * bound column has to its expression and the reason both fill the same cache.
   *
   * It is a different operation from `bind` for everything else. Notation reads
   * no columns, joins no dependency graph, recalculates never, and lives in one
   * cell. The two are called formulas because that is what people call them,
   * and they share a drawer and a file extension; underneath they have almost
   * nothing in common.
   */
  note(row: number, col: number, src: string): void {
    this.record({ seq: 0, op: Op.Note, row, col, was: this.raw(row, col), now: src });
  }

  /**
   * bind makes a column derived: it stores no values of its own from here on,
   * and what it shows is recomputed from the columns the expression names.
   *
   * It records one line for a column of any length, the same trade `apply`
   * makes. The expression is what the file carries, not the 4,812 results, so
   * reopening recomputes them rather than reading them back.
   */
  bind(col: number, f: Formula): void {
    this.record({ seq: 0, op: Op.Bind, row: NO_ROW, col, now: f.toString() });
  }

  /**
   * unbind takes the formula off a column. What it stored before it was bound
   * is what it shows again: binding never removed those values, it only stopped
   * them being what `display` handed out.
   *
   * It is recorded, so it can be undone, and it refuses a column nothing is
   * bound to rather than doing nothing quietly.
   */
  unbind(col: number): void {
    if (col < 0 || col >= this.columns.length) {
      throw new Error(`column ${col} is outside the ${this.columns.length} columns of this sheet`);
    }
    const was = this.binding(col);
    if (was === undefined) {
      throw new Error(`no formula is bound to ${this.columns[col]!.header}`);
    }
    this.record({ seq: 0, op: Op.Unbind, row: NO_ROW, col, was, now: "" });
  }

  /**
   * binding reports the expression a column resolves to. The drawer reads it to
   * show which columns are bound, and a save writes the library reference
   * beside it into sheet state.
   */
  binding(col: number): string | undefined {
    return this.bound.get(col)?.toString();
  }

  /**
   * record numbers an edit, applies it, and keeps it.
   *
   * The callers differ only in the edit they hand over, so there is one path
   * through mutation and re-inference and no way for one of them to forget a
   * step.
   */
  private record(e: Edit): void {
    e.seq = this.log.length + 1;
    this.mutate(e);
    this.inferKindOf(e.col);
    this.log.push(e);
  }

  /**
   * replay applies a log and keeps it, so that saving a reopened file preserves
   * the history rather than starting a new one.
   *
   * It is how a .uno rebuilds itself on open and how undo steps back, which is
   * why it is written to be linear in the number of operations rather than in
   * the number of rows they touch.
   */
  replay(edits: Edit[]): void {
    for (const e of edits) this.mutate(e);

    // A column's kind is a function of the values in it, not of the path taken
    // to them, so a whole log infers once at the end rather than once per
    // operation. Undo replays the log every time it is pressed, and that is
    // what keeps the cost of holding it down proportional to the edits and not
    // to their square.
    for (let col = 0; col < this.columns.length; col++) this.inferKindOf(col);

    this.log.push(...edits);
  }

  /**
   * logEquals reports whether this sheet's log is exactly the one given.
   *
   * It is how a workspace tells whether what it holds is what was written to
   * disk, and it compares rather than counting because undo makes a count
   * ambiguous: taking one edit back and making a different one lands on the
   * same number and a different sheet.
   */
  logEquals(other: Edit[]): boolean {
    return this.log.length === other.length && this.log.every((e, i) => editEquals(e, other[i]!));
  }

  /** What the status bar reports. `edits` copies, so counting through it would
   * allocate the whole log on every status refresh. */
  editCount(): number {
    return this.log.length;
  }

  /**
   * edits returns the log to be written. It copies because the copy is handed
   * to whatever deflates it while the person keeps typing.
   */
  edits(): Edit[] {
    return this.log.map((e) => ({ ...e }));
  }

  // -------------------------------------------------------- the mutations

  /**
   * mutate changes the data and nothing else, so recording and replaying share
   * one path through the checks and differ only in what they do around it.
   */
  private mutate(e: Edit): void {
    // Every operation names a column, whatever it does to the rows under it.
    if (e.col < 0 || e.col >= this.columns.length) {
      throw new Error(
        `edit ${e.seq}: column ${e.col} is outside the ${this.columns.length} columns of this sheet`,
      );
    }

    switch (e.op) {
      case Op.Set:
        this.setCell(e);
        // A cell a person typed into may be read by a bound column, so what
        // follows from it is brought up to date here, where the change is,
        // rather than later where a read would have had to notice.
        this.recalcAfter(e.col);
        return;
      case Op.Apply:
        this.runProgram(e);
        this.recalcAfter(e.col);
        return;
      case Op.Note:
        this.setNote(e);
        return;
      case Op.Bind:
        this.bindColumn(e);
        return;
      case Op.Unbind:
        this.unbindColumn(e);
        return;
      default:
        throw new Error(`edit ${e.seq}: unknown operation ${JSON.stringify(e.op)}`);
    }
  }

  private setCell(e: Edit): void {
    // A derived column has no stored values of its own, so there is nothing
    // here for a person to type over: the next recalculation would discard it
    // without saying so. Refusing names the column instead.
    if (this.bound.has(e.col)) {
      throw new Error(
        `edit ${e.seq}: ${this.columns[e.col]!.header} is computed by a formula, so its cells cannot be typed into`,
      );
    }
    if (e.row < 0 || e.row >= this.rowData.length) {
      throw new Error(
        `edit ${e.seq}: row ${e.row} is outside the ${this.rowData.length} rows of this sheet`,
      );
    }

    // Ragged rows are normal in real exports, so a cell can be edited into
    // existence past the end of its row. Padding here is what keeps `raw`'s
    // tolerance of short rows from turning into a lost value.
    const row = this.rowData[e.row]!;
    if (e.col >= row.length) {
      const grown: string[] = Array.from({ length: this.columns.length }, () => "");
      for (let i = 0; i < row.length; i++) grown[i] = row[i]!;
      this.rowData[e.row] = grown;
    }
    this.rowData[e.row]![e.col] = e.now;
  }

  /**
   * runProgram rewrites one column in place.
   *
   * The program is parsed here rather than carried in the Edit, because an Edit
   * is what a file holds and a file holds text. A log that names a program this
   * build cannot read fails before a single cell moves, which is the difference
   * between refusing to open a workspace and half-transforming one.
   *
   * Short rows are skipped rather than padded. A transform rewrites values that
   * are there; a row that never had this column has no value for it to be wrong
   * about, and inventing an empty cell would change the shape of the data on
   * the strength of an inference.
   */
  private runProgram(e: Edit): void {
    let p: Program;
    try {
      p = parseProgram(e.now);
    } catch (err) {
      throw new Error(`edit ${e.seq}: ${(err as Error).message}`);
    }
    for (const row of this.rowData) {
      if (e.col < row.length) row[e.col] = applyProgram(p, row[e.col]!);
    }
  }

  /**
   * setNote stores the source and renders it once, here, where the cell is
   * authored.
   *
   * Rendering at authoring time rather than at display time is what keeps the
   * grid out of this feature entirely: what `display` returns is finished text,
   * and no markdown parse ever reaches the scroll path.
   */
  private setNote(e: Edit): void {
    if (this.bound.has(e.col)) {
      throw new Error(
        `edit ${e.seq}: ${this.columns[e.col]!.header} is computed by a formula, so its cells cannot hold notation`,
      );
    }
    // Checked before anything is written. `record` does not keep an edit whose
    // mutation failed, but the mutation has already happened by then, and a
    // refused symbol that left its source in the cell would be a refusal only
    // in the error message.
    const bad = notationSupported(e.now);
    if (bad !== undefined) throw new Error(`edit ${e.seq}: ${bad.message}`);

    this.setCell(e);

    let vals = this.computed[e.col];
    if (vals === undefined) {
      vals = Array.from({ length: this.rowData.length }, () => "");
      this.computed[e.col] = vals;
    }
    vals[e.row] = renderNotation(e.now);
  }

  /**
   * bindColumn parses the expression, resolves what it reads, refuses a cycle,
   * and fills the column in.
   *
   * The expression is parsed here rather than carried in the Edit for the
   * reason `runProgram` parses its program here: an Edit is what a file holds
   * and a file holds text.
   */
  private bindColumn(e: Edit): void {
    let f: Formula;
    try {
      f = parseFormula(e.now);
    } catch (err) {
      throw new Error(`edit ${e.seq}: ${(err as Error).message}`);
    }

    // The graph names columns the way a person does, so the column being bound
    // needs a name that means one column. Two headers alike would make one node
    // stand for both, and the cycle check would be answering about the wrong one.
    let name: string;
    try {
      name = this.uniqueHeader(e.col);
    } catch (err) {
      throw new Error(`edit ${e.seq}: ${(err as Error).message}`);
    }

    // A column nothing is bound to but which already fills the cache is one
    // holding notation, and recalculation replaces a column's cache wholesale.
    // Binding over it would leave the sources in place and stop drawing them,
    // which is a loss a person would have to notice rather than be told about.
    if (!this.bound.has(e.col) && this.computed[e.col] !== undefined) {
      throw new Error(
        `edit ${e.seq}: ${name} holds notation, so a formula cannot be bound over it`,
      );
    }

    for (const ref of f.refs()) {
      try {
        this.resolve(ref);
      } catch (err) {
        throw new Error(`edit ${e.seq}: ${(err as Error).message}`);
      }
    }

    try {
      this.graph.bind(name, f);
    } catch (err) {
      throw new Error(`edit ${e.seq}: ${(err as Error).message}`);
    }
    this.bound.set(e.col, f);

    this.recalc(e.col);
    this.recalcAfter(e.col);
  }

  /**
   * unbindColumn gives a column back to its own values.
   *
   * The cache entry is cleared rather than emptied, because "nothing computes
   * this column" is what both `display` and `bindColumn`'s notation guard read.
   * An empty array would leave the column looking computed to the next binding,
   * which would then refuse itself on the grounds that it was about to
   * overwrite notation.
   */
  private unbindColumn(e: Edit): void {
    if (!this.bound.has(e.col)) {
      throw new Error(`edit ${e.seq}: no formula is bound to ${this.columns[e.col]!.header}`);
    }

    // Resolved before anything is dropped: an ambiguous header would leave the
    // graph holding a node this cannot name, and half a removal is worse than
    // none.
    let name: string;
    try {
      name = this.uniqueHeader(e.col);
    } catch (err) {
      throw new Error(`edit ${e.seq}: ${(err as Error).message}`);
    }

    this.bound.delete(e.col);
    this.computed[e.col] = undefined;
    this.graph.unbind(name);

    // A column that read this one was reading what it computed, and is now
    // reading what it stores. downstreamOf still finds those columns: the edges
    // that matter here are theirs, and it is this column's own that were just
    // dropped.
    this.recalcAfter(e.col);
  }

  // ------------------------------------------------------ recalculation

  /**
   * recalcAfter recomputes the columns that read the one that changed, in an
   * order where nothing is computed before what it reads.
   *
   * It runs when an edit lands and never when a cell is read, which is what
   * keeps `display` a cache read. It walks only what is downstream of the
   * change, so the work is proportional to the edit rather than to the sheet:
   * editing a price recomputes margin and touches nothing else.
   */
  private recalcAfter(col: number): void {
    if (this.bound.size === 0) return;

    let name: string;
    try {
      name = this.uniqueHeader(col);
    } catch {
      return; // an ambiguous header binds nothing, so nothing depends on it
    }

    for (const dep of this.graph.downstreamOf(name)) {
      const i = this.columns.findIndex((c) => c.header === dep);
      if (i >= 0) this.recalc(i);
    }
  }

  /**
   * recalc fills one bound column, top to bottom.
   *
   * It is a linear pass and not a partial re-evaluation, because whole-column
   * scope means every row of a column runs the same expression: there is
   * nothing to be clever about.
   */
  private recalc(col: number): void {
    const f = this.bound.get(col);
    if (f === undefined) return;

    const vals: string[] = [];
    const r = new SheetRow(this, 0);
    for (let i = 0; i < this.rowData.length; i++) {
      r.row = i;
      try {
        vals.push(formatValue(evaluate(f, r)));
      } catch {
        vals.push(ERR_CELL);
      }
    }
    this.computed[col] = vals;
  }

  // ------------------------------------------------------------ naming

  /**
   * resolve names a column the way an expression does. First match wins, and an
   * ambiguous name is a failure rather than a guess: two columns called "total"
   * are a spreadsheet a person can work with and an expression nobody can read.
   */
  resolve(name: string): number {
    let found = -1;
    for (let i = 0; i < this.columns.length; i++) {
      if (this.columns[i]!.header !== name) continue;
      if (found >= 0) throw new Error(`more than one column is called ${JSON.stringify(name)}`);
      found = i;
    }
    if (found < 0) throw new Error(`no column is called ${JSON.stringify(name)}`);
    return found;
  }

  /** resolve in the other direction: the name of a column, given that the name
   * has to mean only that column. */
  private uniqueHeader(col: number): string {
    const name = this.columns[col]!.header;
    this.resolve(name);
    return name;
  }

  /**
   * evaluateAt computes one row of an expression without binding it, which is
   * what the editor's preview is: an answer to "what would this do", asked
   * while someone is still typing.
   *
   * It is here rather than in the editor because resolving a header to a column
   * is this module's job, and because a preview that read the sheet differently
   * from the binding would be a preview of something else.
   */
  evaluateAt(f: Formula, row: number): string {
    return formatValue(evaluate(f, new SheetRow(this, row)));
  }

  /**
   * inferKindOf re-reads a column and renames it.
   *
   * A column whose last unparseable value was just fixed is a number column
   * now, and its badge has to say so. Inference reads the same bounded sample
   * it read at load, so an edit below the sample changes nothing -- exactly as
   * that value would not have changed the kind had it arrived in the file.
   */
  private inferKindOf(col: number): void {
    const { kind, flagged } = inferKind(this.rowData.length, (row) => this.display(row, col));
    const c = this.columns[col]!;
    c.kind = kind;
    c.flagged = flagged;
  }
}

/**
 * SheetRow is how an expression reads a row without `formula` learning what a
 * sheet is.
 *
 * It answers with `display` and not `raw` on purpose: a formula may read a
 * column that is itself bound, and what that column is worth is what it
 * computed. Recalculation order is what makes that safe -- the graph emits a
 * column after everything it reads -- so by the time this is asked, the answer
 * is there.
 */
class SheetRow implements Row {
  constructor(
    private readonly s: Sheet,
    public row: number,
  ) {}

  value(col: string): string | undefined {
    let i: number;
    try {
      i = this.s.resolve(col);
    } catch {
      return undefined;
    }
    return this.s.display(this.row, i);
  }
}
