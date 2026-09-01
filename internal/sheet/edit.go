package sheet

import (
	"fmt"
	"slices"
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
	Row int    `json:"row"` // position today; identity from M2 (I-2)
	Col int    `json:"col"`
	Was string `json:"was,omitempty"`
	Now string `json:"now"`
}

// OpSet is the only operation M1 writes. It is spelled out in the file so that
// M2's row-spanning rules can be told apart from single cells by a reader that
// predates them.
const OpSet = "set"

// Set applies an edit and records it. It is the only way the grid changes a
// value, so the log can never fall behind the data it describes.
//
// An out-of-range cell cannot come from the grid, which only offers cells that
// exist, so it means a log that does not belong to these bytes. That is worth an
// error rather than a silent no-op.
func (s *Sheet) Set(row, col int, v string) error {
	e := Edit{
		Seq: len(s.edits) + 1,
		Op:  OpSet,
		Row: row,
		Col: col,
		Was: s.At(row, col),
		Now: v,
	}
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

// mutate changes the data and nothing else, so Set and Replay share one path
// through the bounds checks and the padding and differ only in what they do
// around it.
func (s *Sheet) mutate(e Edit) error {
	if e.Op != OpSet {
		return fmt.Errorf("edit %d: unknown operation %q", e.Seq, e.Op)
	}
	if e.Row < 0 || e.Row >= len(s.rows) {
		return fmt.Errorf("edit %d: row %d is outside the %d rows of this sheet",
			e.Seq, e.Row, len(s.rows))
	}
	if e.Col < 0 || e.Col >= len(s.Columns) {
		return fmt.Errorf("edit %d: column %d is outside the %d columns of this sheet",
			e.Seq, e.Col, len(s.Columns))
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

// inferKindOf re-reads a column and renames it. A column whose last unparseable
// value was just fixed is a number column now, and its badge has to say so.
// Inference reads the same bounded sample it read at load, so an edit below the
// sample changes nothing — exactly as that value would not have changed the kind
// had it arrived in the file.
func (s *Sheet) inferKindOf(col int) {
	kind, flagged := inferKind(s.rows, col)
	s.Columns[col].Kind, s.Columns[col].Flagged = kind, flagged
}
