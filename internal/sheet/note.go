package sheet

import (
	"fmt"

	"github.com/flacyak/uno/internal/notation"
)

// Note puts notation in one cell: the person types markdown and the cell shows
// the symbols it describes.
//
// It is a different operation from Set because it stores a different thing. A
// set cell holds the value it shows. A notation cell holds a source, and what it
// shows is derived from that source, which is the same relationship a bound
// column has to its expression and the reason both fill the same cache.
//
// It is a different operation from Bind for everything else. Notation reads no
// columns, joins no dependency graph, recalculates never, and lives in one cell.
// The two are called formulas because that is what people call them, and they
// share a drawer and a file extension; underneath they have almost nothing in
// common, and this is where that stops being a slogan.
func (s *Sheet) Note(row, col int, src string) error {
	return s.record(Edit{
		Op:  OpNote,
		Row: row,
		Col: col,
		Was: s.Raw(row, col),
		Now: src,
	})
}

// setNote stores the source and renders it once, here, where the cell is
// authored.
//
// Rendering at authoring time rather than at display time is what keeps the grid
// out of this feature entirely. The design doc had Display hand back markdown
// and the grid move from a Label to a RichText to parse it, which would have put
// a markdown parse on the scroll path for every cell including the plain ones,
// and made the whole notation design wait on a scroll measurement. Transliterated
// here, what Display returns is finished text, a Label draws it, and the table's
// binding does not change.
func (s *Sheet) setNote(e Edit) error {
	if _, bound := s.bound[e.Col]; bound {
		return fmt.Errorf("edit %d: %s is computed by a formula, so its cells cannot hold notation",
			e.Seq, s.Columns[e.Col].Header)
	}
	// Checked before anything is written. record does not keep an edit whose
	// mutation failed, but the mutation has already happened by then, and a
	// refused symbol that left its source in the cell would be a refusal only
	// in the error message.
	if err := notation.Supported(e.Now); err != nil {
		return fmt.Errorf("edit %d: %w", e.Seq, err)
	}
	if err := s.setCell(e); err != nil {
		return err
	}

	if s.computed[e.Col] == nil {
		s.computed[e.Col] = make([]string, len(s.rows))
	}
	s.computed[e.Col][e.Row] = notation.Render(e.Now)
	return nil
}
