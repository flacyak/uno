// Package sheet holds one in-memory table per workspace. It imports nothing
// from the packages above it, which is what lets it be tested with no display
// attached (I-6).
package sheet

import "github.com/flacyak/uno/internal/formula"

// Sheet is the one copy of the data in memory. ingest builds it at load, the
// grid reads it every frame, and Set is the single door through which it
// changes (I-7: only ever from the UI goroutine).
type Sheet struct {
	Name string
	// Source describes how ingest read these bytes, for the status bar to show
	// verbatim. It is an opaque label here on purpose: ingest owns the wording,
	// so sheet still knows nothing about delimiters or encodings (I-5).
	Source  string
	Columns []Column
	rows    [][]string
	edits   []Edit // every change made to rows, in order; see edit.go

	// computed is what Display hands out where something has filled it in: a
	// column a formula is bound to, and a cell holding notation. It is indexed
	// by column and nil for a column nothing computes, so the common case costs
	// one bounds check and no allocation on the per-frame path (I-1).
	//
	// A slice and not a map because Display runs about two hundred times a
	// frame, and hashing a key that many times to answer "no" for most of them
	// is work the grid does not have to do.
	computed [][]string

	// bound is the expression each computed column resolves to, and graph is
	// what they depend on. Both are rebuilt by replaying the log, so neither is
	// written to the file: raw plus the log is the whole truth of a workspace
	// (I-4), and a second copy of a binding is a second thing to keep in step.
	bound map[int]formula.Formula
	graph formula.Graph
}

// Column pairs a header with the kind inferred from the values beneath it.
type Column struct {
	Header string
	Kind   Kind // inferred at load; never stored in the file
	// Flagged marks a column that looks numeric but does not parse cleanly,
	// such as one whose thousands separators break half its values. It is the
	// condition M2's pattern recogniser acts on.
	Flagged bool
}

// New builds a sheet from a header row and the data rows beneath it, inferring
// each column's kind as it goes. A row longer than the header contributes no
// column: the header decides the shape, and At tolerates the overhang.
func New(name string, header []string, rows [][]string) *Sheet {
	s := &Sheet{
		Name:     name,
		Columns:  make([]Column, len(header)),
		rows:     rows,
		computed: make([][]string, len(header)),
	}
	for i, h := range header {
		s.Columns[i].Header = h
		s.inferKindOf(i)
	}
	return s
}

func (s *Sheet) Rows() int { return len(s.rows) }
func (s *Sheet) Cols() int { return len(s.Columns) }

// Raw is what the cell stores. The log records it, undo restores it, and the
// recogniser reads it, because all three are about the value a person put there
// rather than the one they are being shown.
//
// An absent cell is empty rather than an error: short rows are normal in real
// exports, and returning "" is what lets the table skip bounds checks while
// scrolling.
func (s *Sheet) Raw(row, col int) string {
	if row < 0 || row >= len(s.rows) {
		return ""
	}
	if col < 0 || col >= len(s.rows[row]) {
		return ""
	}
	return s.rows[row][col]
}

// Display is what the cell shows, and what the grid binds to. It is called once
// per visible cell on every scroll frame (I-1), so it reads and returns:
// whatever fills it in does so when an edit lands, never when a cell is read.
//
// The body is a cache read and nothing else. Recalculation fills it when an
// edit lands, walking the dependency graph in order; a notation cell fills its
// own entry when it is authored. Evaluating here instead would put an expression
// tree walk on the scroll path, which is the exact mistake this seam exists to
// prevent.
func (s *Sheet) Display(row, col int) string {
	if col >= 0 && col < len(s.computed) {
		if vals := s.computed[col]; row >= 0 && row < len(vals) {
			if v := vals[row]; v != "" {
				return v
			}
		}
	}
	return s.Raw(row, col)
}
