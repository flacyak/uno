package sheet

import (
	"strings"
	"testing"
)

func noted(t *testing.T) *Sheet {
	t.Helper()
	return New("t.csv",
		[]string{"label", "value"},
		[][]string{{"", "1"}, {"", "2"}},
	)
}

// A notation cell keeps the markdown someone typed and shows the symbols it
// describes. Both halves matter: the source is what they edit and what a diff
// reads, and the symbols are what the grid draws.
func TestANotationCellStoresItsSourceAndShowsItsSymbols(t *testing.T) {
	s := noted(t)

	if err := s.Note(0, 0, "x^2"); err != nil {
		t.Fatalf("Note: %v", err)
	}

	if got, want := s.Raw(0, 0), "x^2"; got != want {
		t.Errorf("Raw = %q, want the source %q", got, want)
	}
	if got, want := s.Display(0, 0), "x²"; got != want {
		t.Errorf("Display = %q, want %q", got, want)
	}
}

// The whole point of refusing at authoring time is that a person finds out while
// they are still typing, rather than finding an empty box in a cell later.
func TestASymbolTheFontCannotDrawIsRefusedWhenItIsTyped(t *testing.T) {
	s := noted(t)

	err := s.Note(0, 0, "x_q")
	if err == nil {
		t.Fatal("a subscript with no glyph was accepted")
	}
	if got := s.Raw(0, 0); got != "" {
		t.Errorf("Raw = %q, want the refused source not stored", got)
	}
	if s.EditCount() != 0 {
		t.Error("the refused note was recorded")
	}
}

// One cache serves both kinds. A notation cell fills its own entry, and every
// other cell in that column still falls through to what it stores.
func TestANotationCellLeavesTheRestOfItsColumnAlone(t *testing.T) {
	s := noted(t)
	if err := s.Set(1, 0, "plain"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if err := s.Note(0, 0, "\\alpha"); err != nil {
		t.Fatalf("Note: %v", err)
	}

	if got, want := s.Display(0, 0), "α"; got != want {
		t.Errorf("noted cell = %q, want %q", got, want)
	}
	if got, want := s.Display(1, 0), "plain"; got != want {
		t.Errorf("plain cell = %q, want %q", got, want)
	}
}

// Notation replays out of the log like everything else, which is what lets the
// file store the source and rebuild the symbols rather than storing both.
func TestNotationReplaysFromItsSource(t *testing.T) {
	s := noted(t)
	if err := s.Note(0, 0, "e^{x}"); err != nil {
		t.Fatalf("Note: %v", err)
	}

	replayed := noted(t)
	if err := replayed.Replay(s.Edits()); err != nil {
		t.Fatalf("Replay: %v", err)
	}

	if got, want := replayed.Display(0, 0), s.Display(0, 0); got != want {
		t.Errorf("replayed = %q, want %q", got, want)
	}
}

// Binding over notation would leave the sources stored and stop drawing them,
// because recalculation replaces a column's cache wholesale. That is a loss a
// person would have to spot for themselves, so it is refused instead.
func TestAFormulaCannotBeBoundOverAColumnHoldingNotation(t *testing.T) {
	s := noted(t)
	if err := s.Note(0, 0, "x^2"); err != nil {
		t.Fatalf("Note: %v", err)
	}

	err := s.Bind(0, parse(t, "value * 2"))
	if err == nil {
		t.Fatal("a formula was bound over a column holding notation")
	}
	if !strings.Contains(err.Error(), "notation") {
		t.Errorf("error %q does not say why", err)
	}
	if got, want := s.Display(0, 0), "x²"; got != want {
		t.Errorf("Display = %q, want the notation still drawn", got)
	}
}

// And the other way round: a derived column shows what it computes, so there is
// nowhere in it to put notation.
func TestNotationCannotBeWrittenIntoABoundColumn(t *testing.T) {
	s := noted(t)
	if err := s.Bind(0, parse(t, "value * 2")); err != nil {
		t.Fatalf("Bind: %v", err)
	}

	if err := s.Note(0, 0, "x^2"); err == nil {
		t.Fatal("a bound column accepted notation")
	}
	if got, want := s.Display(0, 0), "2"; got != want {
		t.Errorf("Display = %q, want the computed %q", got, want)
	}
}
