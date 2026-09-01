// Package sheet holds one in-memory table per workspace. It imports nothing
// from the packages above it, which is what lets it be tested with no display
// attached (I-6).
package sheet

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
	s := &Sheet{Name: name, Columns: make([]Column, len(header)), rows: rows}
	for i, h := range header {
		kind, flagged := inferKind(rows, i)
		s.Columns[i] = Column{Header: h, Kind: kind, Flagged: flagged}
	}
	return s
}

func (s *Sheet) Rows() int { return len(s.rows) }
func (s *Sheet) Cols() int { return len(s.Columns) }

// At is called once per visible cell on every scroll frame (I-1). Keep it
// allocation free, and treat an absent cell as empty rather than as an error:
// short rows are normal in real exports, and returning "" is what lets the
// table skip bounds checks while scrolling.
func (s *Sheet) At(row, col int) string {
	if row < 0 || row >= len(s.rows) {
		return ""
	}
	if col < 0 || col >= len(s.rows[row]) {
		return ""
	}
	return s.rows[row][col]
}
