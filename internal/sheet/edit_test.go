package sheet

import "testing"

// rows returns a fresh copy each call, since Set mutates in place.
func fixture() *Sheet {
	return New("sales.csv",
		[]string{"date", "region", "units"},
		[][]string{
			{"2026-07-01", "West", "1,204"},
			{"2026-07-01", "East", "987"},
			{"2026-07-02", "North", "1,455"},
		})
}

// An edit records what it replaced, which is what makes it readable on its own
// and reversible without re-reading the source.
func TestSetRecordsTheValueItReplaced(t *testing.T) {
	s := fixture()

	if err := s.Set(0, 2, "1204"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if got := s.At(0, 2); got != "1204" {
		t.Errorf("cell = %q, want %q", got, "1204")
	}

	log := s.Edits()
	if len(log) != 1 {
		t.Fatalf("log = %v, want one entry", log)
	}
	want := Edit{Seq: 1, Op: OpSet, Row: 0, Col: 2, Was: "1,204", Now: "1204"}
	if log[0] != want {
		t.Errorf("entry = %+v, want %+v", log[0], want)
	}
}

// Edits is handed to a worker goroutine that writes it while the person keeps
// typing, so it must not alias the log the sheet goes on appending to.
func TestEditsDoesNotAliasTheLog(t *testing.T) {
	s := fixture()
	if err := s.Set(0, 2, "1204"); err != nil {
		t.Fatalf("Set: %v", err)
	}

	snapshot := s.Edits()
	if err := s.Set(1, 2, "987!"); err != nil {
		t.Fatalf("Set: %v", err)
	}

	if len(snapshot) != 1 {
		t.Errorf("snapshot grew to %d entries", len(snapshot))
	}
	if s.EditCount() != 2 {
		t.Errorf("EditCount = %d, want 2", s.EditCount())
	}
}

// Fixing the last unparseable value in a column is what clears its warning
// badge, so the kind is re-inferred as the edit lands rather than at the next open.
func TestFixingTheLastBadValueClearsTheFlag(t *testing.T) {
	s := fixture()
	if c := s.Columns[2]; c.Kind != KindText || !c.Flagged {
		t.Fatalf("units started as %v flagged=%v, want a flagged text column",
			c.Kind, c.Flagged)
	}

	for _, e := range []struct {
		row int
		now string
	}{{0, "1204"}, {2, "1455"}} {
		if err := s.Set(e.row, 2, e.now); err != nil {
			t.Fatalf("Set: %v", err)
		}
	}

	if c := s.Columns[2]; c.Kind != KindNum || c.Flagged {
		t.Errorf("units is now %v flagged=%v, want an unflagged num column",
			c.Kind, c.Flagged)
	}
	if s.Columns[2].Header != "units" {
		t.Error("re-inferring the kind lost the column's header")
	}
}

// Ragged rows are normal in real exports. Editing a cell past the end of its
// row has to create it rather than be swallowed by At's tolerance of short rows.
func TestSetGrowsAShortRow(t *testing.T) {
	s := New("ragged.csv",
		[]string{"a", "b", "c"},
		[][]string{{"1"}, {"2", "3", "4"}})

	if err := s.Set(0, 2, "filled"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if got := s.At(0, 2); got != "filled" {
		t.Errorf("cell = %q, want %q", got, "filled")
	}
	if got := s.At(0, 1); got != "" {
		t.Errorf("the padded cell = %q, want it empty", got)
	}
}

// Replay is how a .uno rebuilds itself, and it must keep the log it replayed so
// that saving a reopened file preserves the history rather than starting a new one.
func TestReplayRebuildsAndKeepsTheLog(t *testing.T) {
	edits := []Edit{
		{Seq: 1, Op: OpSet, Row: 0, Col: 2, Was: "1,204", Now: "1204"},
		{Seq: 2, Op: OpSet, Row: 2, Col: 2, Was: "1,455", Now: "1455"},
	}

	s := fixture()
	if err := s.Replay(edits); err != nil {
		t.Fatalf("Replay: %v", err)
	}

	if got := s.At(0, 2); got != "1204" {
		t.Errorf("cell = %q, want the replayed value", got)
	}
	if s.EditCount() != 2 {
		t.Errorf("EditCount = %d, want the replayed log kept", s.EditCount())
	}
	if err := s.Set(1, 2, "986"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if got := s.Edits()[2].Seq; got != 3 {
		t.Errorf("seq after replay = %d, want it to carry on at 3", got)
	}
}

// A log that names a cell this sheet does not have is a log that does not belong
// to these bytes, and opening must say so rather than build a wrong grid.
func TestReplayRefusesALogThatDoesNotFit(t *testing.T) {
	for name, e := range map[string]Edit{
		"row past the end":    {Seq: 1, Op: OpSet, Row: 9, Col: 0, Now: "x"},
		"column past the end": {Seq: 1, Op: OpSet, Row: 0, Col: 9, Now: "x"},
		"unknown operation":   {Seq: 1, Op: "rule", Row: 0, Col: 0, Now: "x"},
	} {
		t.Run(name, func(t *testing.T) {
			if err := fixture().Replay([]Edit{e}); err == nil {
				t.Error("want an error, got nil")
			}
		})
	}
}
