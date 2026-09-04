package sheet

import "testing"

func TestAtToleratesRaggedAndOutOfRange(t *testing.T) {
	// The second row is short: a real export does this, and the grid must not
	// have to bounds-check while scrolling (I-1).
	s := New("t.csv",
		[]string{"a", "b", "c"},
		[][]string{{"1", "2", "3"}, {"4"}},
	)

	for _, c := range []struct {
		name     string
		row, col int
		want     string
	}{
		{"present", 0, 1, "2"},
		{"short row", 1, 2, ""},
		{"row past end", 9, 0, ""},
		{"negative row", -1, 0, ""},
		{"col past end", 0, 9, ""},
		{"negative col", 0, -1, ""},
	} {
		if got := s.At(c.row, c.col); got != c.want {
			t.Errorf("%s: At(%d,%d) = %q, want %q", c.name, c.row, c.col, got, c.want)
		}
	}
}

func TestRowsAndColsCountDataNotHeader(t *testing.T) {
	s := New("t.csv", []string{"a", "b"}, [][]string{{"1", "2"}, {"3", "4"}})
	if s.Rows() != 2 {
		t.Errorf("Rows() = %d, want 2", s.Rows())
	}
	if s.Cols() != 2 {
		t.Errorf("Cols() = %d, want 2", s.Cols())
	}
}

// TestInferKind covers the four columns the design doc draws, including the
// flagged one that the whole feature exists for.
func TestInferKind(t *testing.T) {
	s := New("t.csv",
		[]string{"date", "region", "units", "revenue", "blank"},
		[][]string{
			{"2026-07-01", "West", "1,204", "48160.00", ""},
			{"2026-07-01", "East", "987", "39480.00", ""},
			{"2026-07-02", "North", "1,455", "58200.00", ""},
		},
	)

	for _, c := range []struct {
		col         int
		wantKind    Kind
		wantFlagged bool
	}{
		{0, KindDate, false},
		{1, KindText, false},
		{2, KindText, true}, // numbers wearing thousands separators
		{3, KindNum, false},
		{4, KindText, false}, // no evidence at all
	} {
		got := s.Columns[c.col]
		if got.Kind != c.wantKind || got.Flagged != c.wantFlagged {
			t.Errorf("column %q: kind=%v flagged=%v, want kind=%v flagged=%v",
				got.Header, got.Kind, got.Flagged, c.wantKind, c.wantFlagged)
		}
	}
}

// The costume a number wears is not always a comma.
func TestInferKindFlagsTheOtherDecorations(t *testing.T) {
	s := New("t.csv",
		[]string{"amount", "rate", "swiss", "spaced", "mixed"},
		[][]string{
			{"$1,204", "12.5%", "1'204", "1 204", "$1,204"},
			{"$87", "3%", "9'870", "9 870", "N/A"},
			{"$3,010", "88.1%", "2'000", "2 000", "$3,010"},
		},
	)

	for _, c := range []struct {
		col         int
		wantKind    Kind
		wantFlagged bool
	}{
		{0, KindText, true},  // currency and separators
		{1, KindText, true},  // percent
		{2, KindText, true},  // apostrophe separator
		{3, KindText, true},  // space separator
		{4, KindText, false}, // a genuine non-number keeps it mixed
	} {
		got := s.Columns[c.col]
		if got.Kind != c.wantKind || got.Flagged != c.wantFlagged {
			t.Errorf("column %q: kind=%v flagged=%v, want kind=%v flagged=%v",
				got.Header, got.Kind, got.Flagged, c.wantKind, c.wantFlagged)
		}
	}
}

// A column of numbers with genuinely non-numeric values in it is mixed, not
// misformatted, so it must not raise the flag M2 acts on.
func TestInferKindDoesNotFlagGenuinelyMixedColumns(t *testing.T) {
	s := New("t.csv", []string{"units"},
		[][]string{{"12"}, {"34"}, {"56"}, {"N/A"}})

	if c := s.Columns[0]; c.Kind != KindText || c.Flagged {
		t.Errorf("kind=%v flagged=%v, want text and unflagged", c.Kind, c.Flagged)
	}
}

func TestIsNumberRejectsWhatASpreadsheetDoesNotMean(t *testing.T) {
	for _, v := range []string{"12", "-3.5", "+7", "1e3", "0.0"} {
		if !isNumber(v) {
			t.Errorf("isNumber(%q) = false, want true", v)
		}
	}
	// ParseFloat alone accepts all of these; a column of them is not numeric.
	for _, v := range []string{"inf", "NaN", "0x1p-2", "1,204", "", "12 "} {
		if isNumber(v) {
			t.Errorf("isNumber(%q) = true, want false", v)
		}
	}
}
