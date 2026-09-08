package sheet

import (
	"fmt"
	"strconv"

	"github.com/flacyak/uno/internal/formula"
)

// errCell is what a bound column shows where its expression could not read a
// row: a divisor of zero, a cell holding "N/A". It is short because it has to
// fit a column sized for numbers, and it is unmistakable because the alternative
// -- an empty cell -- reads as missing data rather than as a failure. The reason
// is said in the editor, beside the expression, where there is room for it.
const errCell = "#ERR"

// Bind makes a column derived: it stores no values of its own from here on, and
// what it shows is recomputed from the columns the expression names.
//
// It records one line for a column of any length, the same trade Apply makes.
// The expression is what the file carries, not the 4,812 results, so reopening
// recomputes them rather than reading them back.
func (s *Sheet) Bind(col int, f formula.Formula) error {
	return s.record(Edit{
		Op:  OpBind,
		Row: NoRow,
		Col: col,
		Now: f.String(),
	})
}

// Binding reports the expression a column resolves to. The drawer reads it to
// show which columns are bound, and a save writes the library reference beside
// it into sheet state.
func (s *Sheet) Binding(col int) (string, bool) {
	f, ok := s.bound[col]
	if !ok {
		return "", false
	}
	return f.String(), true
}

// bindColumn parses the expression, resolves what it reads, refuses a cycle, and
// fills the column in.
//
// The expression is parsed here rather than carried in the Edit for the reason
// runProgram parses its program here: an Edit is what a file holds and a file
// holds text. A binding this build cannot read has to fail before a single value
// is computed, which is the difference between refusing to open a workspace and
// half-computing one.
func (s *Sheet) bindColumn(e Edit) error {
	f, err := formula.Parse(e.Now)
	if err != nil {
		return fmt.Errorf("edit %d: %w", e.Seq, err)
	}

	// The graph names columns the way a person does, so the column being bound
	// needs a name that means one column. Two headers alike would make one node
	// stand for both, and the cycle check would be answering about the wrong
	// one.
	name, err := s.uniqueHeader(e.Col)
	if err != nil {
		return fmt.Errorf("edit %d: %w", e.Seq, err)
	}
	for _, ref := range f.Refs() {
		if _, err := s.resolve(ref); err != nil {
			return fmt.Errorf("edit %d: %w", e.Seq, err)
		}
	}

	if err := s.graph.Bind(name, f); err != nil {
		return fmt.Errorf("edit %d: %w", e.Seq, err)
	}
	if s.bound == nil {
		s.bound = map[int]formula.Formula{}
	}
	s.bound[e.Col] = f

	s.recalc(e.Col)
	s.recalcAfter(e.Col)
	return nil
}

// recalcAfter recomputes the columns that read the one that changed, in an order
// where nothing is computed before what it reads.
//
// It runs when an edit lands and never when a cell is read, which is what keeps
// Display a cache read (I-1). It walks only what is downstream of the change, so
// the work is proportional to the edit rather than to the sheet: editing a price
// recomputes margin and touches nothing else.
func (s *Sheet) recalcAfter(col int) {
	if len(s.bound) == 0 {
		return
	}
	name, err := s.uniqueHeader(col)
	if err != nil {
		return // an ambiguous header binds nothing, so nothing depends on it
	}
	for _, dep := range s.graph.DownstreamOf(name) {
		if i, err := s.resolve(dep); err == nil {
			s.recalc(i)
		}
	}
}

// recalc fills one bound column, top to bottom. It is a linear pass and not a
// partial re-evaluation, because whole-column scope means every row of a column
// runs the same expression: there is nothing to be clever about.
func (s *Sheet) recalc(col int) {
	f, ok := s.bound[col]
	if !ok {
		return
	}

	vals := make([]string, len(s.rows))
	r := &sheetRow{s: s}
	for i := range s.rows {
		r.row = i
		v, err := f.Eval(r)
		if err != nil {
			vals[i] = errCell
			continue
		}
		vals[i] = formatValue(v)
	}
	s.computed[col] = vals
}

// sheetRow is how an expression reads a row without formula learning what a
// sheet is.
//
// It answers with Display and not Raw on purpose: a formula may read a column
// that is itself bound, and what that column is worth is what it computed.
// Recalculation order is what makes that safe -- the graph emits a column after
// everything it reads -- so by the time this is asked, the answer is there.
type sheetRow struct {
	s   *Sheet
	row int
}

func (r *sheetRow) Value(col string) (string, bool) {
	i, err := r.s.resolve(col)
	if err != nil {
		return "", false
	}
	return r.s.Display(r.row, i), true
}

// formatValue renders a computed number the way a spreadsheet does.
//
// The rounding is the point. (40.00 - 31.20) / 40.00 is 0.21999999999999997 in
// binary floating point, and a column of those is arithmetic showing its
// working. Ten significant digits is far more precision than a cell displays and
// far less than float64 noise, so it removes the artefact without removing an
// answer. The second pass turns the result back into plain notation, since a
// spreadsheet column showing 1.234567890e+12 has helped nobody.
func formatValue(v float64) string {
	rounded, err := strconv.ParseFloat(strconv.FormatFloat(v, 'g', 10, 64), 64)
	if err != nil {
		rounded = v
	}
	return strconv.FormatFloat(rounded, 'f', -1, 64)
}

// resolve names a column the way an expression does. First match wins, and an
// ambiguous name is an error rather than a guess: two columns called "total" are
// a spreadsheet a person can work with and an expression nobody can read.
func (s *Sheet) resolve(name string) (int, error) {
	found := -1
	for i, c := range s.Columns {
		if c.Header != name {
			continue
		}
		if found >= 0 {
			return -1, fmt.Errorf("more than one column is called %q", name)
		}
		found = i
	}
	if found < 0 {
		return -1, fmt.Errorf("no column is called %q", name)
	}
	return found, nil
}

// uniqueHeader is resolve in the other direction: the name of a column, given
// that the name has to mean only that column.
func (s *Sheet) uniqueHeader(col int) (string, error) {
	name := s.Columns[col].Header
	if _, err := s.resolve(name); err != nil {
		return "", err
	}
	return name, nil
}
