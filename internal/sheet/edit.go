package sheet

import (
	"fmt"
	"slices"

	"github.com/flacyak/uno/internal/program"
)

// Edit is one recorded change, and the unit the .uno edit log stores. A sheet
// keeps every edit made to it in order, because that log plus the immutable raw
// source (I-4) is the whole truth of a saved workspace: replay rebuilds it, and
// undo is truncate-and-replay rather than a stack held in memory.
//
// Was is what makes an edit readable on its own, in a diff or an unzip, without
// replaying anything up to it. Ops that change thousands of cells at once will
// not carry one, so nothing may depend on it being present.
type Edit struct {
	Seq int    `json:"seq"`
	Op  string `json:"op"`
	Row int    `json:"row"` // position today, NoRow on a column op; identity from M2 (I-2)
	Col int    `json:"col"`
	Was string `json:"was,omitempty"`

	// Now is the cell's new value under OpSet, the markdown source under OpNote,
	// the program text under OpApply and the expression text under OpBind. One
	// field rather than four because
	// they are the same thing at different scopes — what this operation makes
	// the data say — and a second field would have to be empty in every line of
	// every log written so far.
	Now string `json:"now"`
}

// The operations. Each is spelled out in the file so a reader that predates one
// of them can tell a row-spanning rule from a single cell rather than guessing
// from which fields happen to be set.
const (
	// OpSet is one cell, and the only operation M1 wrote.
	OpSet = "set"

	// OpApply is a program run over a whole column: the transformation the
	// recogniser induced from a handful of edits and the person agreed to. It
	// carries no Was, because thousands of old values are not a field, which is
	// why undo replays the log rather than reversing it.
	OpApply = "apply"

	// OpNote is notation in one cell: markdown stored, symbols shown. It is one
	// cell like OpSet and derived like OpBind, and it is neither of them —
	// setting a cell would lose the source the symbols came from, and binding
	// would make a thing that reads no columns join a dependency graph.
	OpNote = "note"

	// OpBind makes a column derived: from here on it stores nothing of its own
	// and shows what the expression computes.
	//
	// It is an operation and not a line of sheet state, though it looks like
	// one. A binding is something a person did, so it has to be something they
	// can undo, and undo is truncate-and-replay of this log. Putting it in
	// state.json would have left Ctrl+Z unable to reach it.
	OpBind = "bind"
)

// NoRow is what a column-spanning op stores in Row. A log is read by people
// with unzip as well as by uno, and -1 says "this one is not about a row" where
// a plausible 0 would quietly point at the first one.
const NoRow = -1

// Set applies an edit and records it. It is the only way the grid changes a
// single value, so the log can never fall behind the data it describes.
//
// An out-of-range cell cannot come from the grid, which only offers cells that
// exist, so it means a log that does not belong to these bytes. That is worth an
// error rather than a silent no-op.
func (s *Sheet) Set(row, col int, v string) error {
	return s.record(Edit{
		Op:  OpSet,
		Row: row,
		Col: col,
		Was: s.Raw(row, col),
		Now: v,
	})
}

// Apply runs a program over every value in a column and records it as one
// operation. It is the door a pattern proposal comes through, and the reason
// the log stays proportional to what a person did rather than to how much data
// they did it to: 3,149 cells change and one line is written.
func (s *Sheet) Apply(col int, p program.Program) error {
	return s.record(Edit{
		Op:  OpApply,
		Row: NoRow,
		Col: col,
		Now: p.String(),
	})
}

// record numbers an edit, applies it, and keeps it. Set and Apply differ only
// in the edit they hand over, so there is one path through mutation and
// re-inference and no way for one of them to forget a step.
func (s *Sheet) record(e Edit) error {
	e.Seq = len(s.edits) + 1
	if err := s.mutate(e); err != nil {
		return err
	}
	s.inferKindOf(e.Col)
	s.edits = append(s.edits, e)
	return nil
}

// Replay applies a log and keeps it, so that saving a reopened file preserves
// the history rather than starting a new one. It is how a .uno rebuilds itself
// on open and how undo steps back, which is why it is written to be linear in
// the number of operations rather than in the number of rows they touch.
func (s *Sheet) Replay(edits []Edit) error {
	for _, e := range edits {
		if err := s.mutate(e); err != nil {
			return err
		}
	}

	// A column's kind is a function of the values in it, not of the path taken
	// to them, so a whole log infers once at the end rather than once per
	// operation. Undo replays the log every time it is pressed, and that is what
	// keeps the cost of holding it down proportional to the edits and not to
	// their square.
	for col := range s.Columns {
		s.inferKindOf(col)
	}

	s.edits = append(s.edits, edits...)
	return nil
}

// LogEquals reports whether this sheet's log is exactly the one given. It is how
// a workspace tells whether what it holds is what was written to disk, and it
// compares rather than counting because undo makes a count ambiguous: taking one
// edit back and making a different one lands on the same number and a different
// sheet.
func (s *Sheet) LogEquals(other []Edit) bool { return slices.Equal(s.edits, other) }

// EditCount is what the status bar reports. Edits copies, so counting through it
// would allocate the whole log on every status refresh.
func (s *Sheet) EditCount() int { return len(s.edits) }

// Edits returns the log to be written. It copies because the copy is handed to a
// worker goroutine that deflates it while the person keeps typing, and I-7 only
// promises that the sheet itself is mutated on the UI goroutine.
func (s *Sheet) Edits() []Edit {
	out := make([]Edit, len(s.edits))
	copy(out, s.edits)
	return out
}

// mutate changes the data and nothing else, so recording and replaying share one
// path through the checks and differ only in what they do around it.
func (s *Sheet) mutate(e Edit) error {
	// Every operation names a column, whatever it does to the rows under it.
	if e.Col < 0 || e.Col >= len(s.Columns) {
		return fmt.Errorf("edit %d: column %d is outside the %d columns of this sheet",
			e.Seq, e.Col, len(s.Columns))
	}

	switch e.Op {
	case OpSet:
		if err := s.setCell(e); err != nil {
			return err
		}
		// A cell a person typed into may be read by a bound column, so what
		// follows from it is brought up to date here, where the change is,
		// rather than later where a read would have had to notice.
		s.recalcAfter(e.Col)
		return nil
	case OpApply:
		if err := s.runProgram(e); err != nil {
			return err
		}
		s.recalcAfter(e.Col)
		return nil
	case OpNote:
		return s.setNote(e)
	case OpBind:
		return s.bindColumn(e)
	default:
		return fmt.Errorf("edit %d: unknown operation %q", e.Seq, e.Op)
	}
}

func (s *Sheet) setCell(e Edit) error {
	// A derived column has no stored values of its own, so there is nothing
	// here for a person to type over: the next recalculation would discard it
	// without saying so. Refusing names the column instead.
	if _, bound := s.bound[e.Col]; bound {
		return fmt.Errorf("edit %d: %s is computed by a formula, so its cells cannot be typed into",
			e.Seq, s.Columns[e.Col].Header)
	}
	if e.Row < 0 || e.Row >= len(s.rows) {
		return fmt.Errorf("edit %d: row %d is outside the %d rows of this sheet",
			e.Seq, e.Row, len(s.rows))
	}

	// Ragged rows are normal in real exports, so a cell can be edited into
	// existence past the end of its row. Padding here is what keeps At's
	// tolerance of short rows from turning into a lost value.
	if row := s.rows[e.Row]; e.Col >= len(row) {
		grown := make([]string, len(s.Columns))
		copy(grown, row)
		s.rows[e.Row] = grown
	}
	s.rows[e.Row][e.Col] = e.Now
	return nil
}

// runProgram rewrites one column in place.
//
// The program is parsed here rather than carried in the Edit, because an Edit is
// what a file holds and a file holds text. A log that names a program this build
// cannot read fails before a single cell moves, which is the difference between
// refusing to open a workspace and half-transforming one.
//
// Short rows are skipped rather than padded. A transform rewrites values that
// are there; a row that never had this column has no value for it to be wrong
// about, and inventing an empty cell would change the shape of the data on the
// strength of an inference.
func (s *Sheet) runProgram(e Edit) error {
	p, err := program.Parse(e.Now)
	if err != nil {
		return fmt.Errorf("edit %d: %w", e.Seq, err)
	}
	for _, row := range s.rows {
		if e.Col < len(row) {
			row[e.Col] = p.Apply(row[e.Col])
		}
	}
	return nil
}

// inferKindOf re-reads a column and renames it. A column whose last unparseable
// value was just fixed is a number column now, and its badge has to say so.
// Inference reads the same bounded sample it read at load, so an edit below the
// sample changes nothing — exactly as that value would not have changed the kind
// had it arrived in the file.
func (s *Sheet) inferKindOf(col int) {
	kind, flagged := inferKind(len(s.rows), func(row int) string {
		return s.Display(row, col)
	})
	s.Columns[col].Kind, s.Columns[col].Flagged = kind, flagged
}
