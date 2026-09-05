package sheet

import (
	"strings"
	"testing"

	"github.com/flacyak/uno/internal/formula"
)

// parse is the fixture every binding test starts from. A formula that does not
// parse is a mistake in the test rather than the thing under test, so it stops
// the test rather than becoming a failure to read later.
func parse(t *testing.T, src string) formula.Formula {
	t.Helper()
	f, err := formula.Parse(src)
	if err != nil {
		t.Fatalf("Parse(%q): %v", src, err)
	}
	return f
}

// sales returns a fresh sheet each call, since binding mutates in place.
func sales(t *testing.T) *Sheet {
	t.Helper()
	return New("sales.csv",
		[]string{"region", "price", "cost", "margin"},
		[][]string{
			{"West", "40.00", "31.20", ""},
			{"East", "40.00", "30.00", ""},
			{"North", "50.00", "25.00", ""},
		},
	)
}

// A bound column computes every row from the columns its expression names, and
// it does so from one recorded line rather than from three stored values. That
// ratio is the whole argument for storing the expression instead of the results.
func TestBindingAColumnFillsItFromOneLine(t *testing.T) {
	s := sales(t)

	if err := s.Bind(3, parse(t, "(price - cost) / price")); err != nil {
		t.Fatalf("Bind: %v", err)
	}

	for row, want := range []string{"0.22", "0.25", "0.5"} {
		if got := s.Display(row, 3); got != want {
			t.Errorf("row %d = %q, want %q", row, got, want)
		}
	}
	if got := s.EditCount(); got != 1 {
		t.Errorf("log holds %d edits, want the binding to be one line", got)
	}
}

// Binary floating point makes (40.00 - 31.20) / 40.00 into 0.21999999999999997,
// and a column of those is arithmetic showing its working rather than answering.
func TestAComputedValueIsNotShownWithItsFloatingPointNoise(t *testing.T) {
	s := sales(t)
	if err := s.Bind(3, parse(t, "(price - cost) / price")); err != nil {
		t.Fatalf("Bind: %v", err)
	}

	if got := s.Display(0, 3); strings.Contains(got, "999999") {
		t.Errorf("Display = %q, want the artefact rounded away", got)
	}
}

// Editing an input recomputes what reads it. Nothing else moves, because the
// walk is over what is downstream of the change rather than over the sheet.
func TestEditingAnInputUpdatesTheColumnThatReadsIt(t *testing.T) {
	s := sales(t)
	if err := s.Bind(3, parse(t, "price - cost")); err != nil {
		t.Fatalf("Bind: %v", err)
	}
	before := s.Display(1, 3)

	if err := s.Set(0, 2, "20.00"); err != nil {
		t.Fatalf("Set: %v", err)
	}

	if got, want := s.Display(0, 3), "20"; got != want {
		t.Errorf("edited row = %q, want %q", got, want)
	}
	if got := s.Display(1, 3); got != before {
		t.Errorf("untouched row = %q, want it left at %q", got, before)
	}
}

// A cycle is refused where a person can still do something about it, and the
// error names the loop rather than reporting that one exists.
func TestACycleIsRefusedAtBindTimeWithThePathNamed(t *testing.T) {
	s := sales(t)
	if err := s.Bind(3, parse(t, "price - cost")); err != nil {
		t.Fatalf("Bind: %v", err)
	}

	err := s.Bind(1, parse(t, "margin + cost"))
	if err == nil {
		t.Fatal("binding price to something that reads margin was accepted")
	}
	if !strings.Contains(err.Error(), "margin") || !strings.Contains(err.Error(), "price") {
		t.Errorf("error %q names neither end of the loop", err)
	}
	if s.EditCount() != 1 {
		t.Error("the refused binding was recorded anyway")
	}
	if got := s.Display(0, 1); got != "40.00" {
		t.Errorf("price = %q, want the refusal to have changed nothing", got)
	}
}

// A derived column stores nothing, so typing into one would be typing something
// the next recalculation discards without saying so.
func TestACellInABoundColumnCannotBeTypedInto(t *testing.T) {
	s := sales(t)
	if err := s.Bind(3, parse(t, "price - cost")); err != nil {
		t.Fatalf("Bind: %v", err)
	}

	if err := s.Set(0, 3, "nonsense"); err == nil {
		t.Fatal("a bound column accepted a typed value")
	}
	if got, want := s.Display(0, 3), "8.8"; got != want {
		t.Errorf("Display = %q, want the computed %q", got, want)
	}
}

// A row the expression cannot read says so in the cell it happened in. An empty
// cell would read as missing data, which is a different thing entirely.
func TestARowTheExpressionCannotReadSaysSo(t *testing.T) {
	s := New("t.csv",
		[]string{"a", "b", "c"},
		[][]string{{"10", "2", ""}, {"10", "0", ""}, {"10", "N/A", ""}},
	)
	if err := s.Bind(2, parse(t, "a / b")); err != nil {
		t.Fatalf("Bind: %v", err)
	}

	for _, c := range []struct {
		row  int
		want string
	}{
		{0, "5"},
		{1, errCell}, // divide by zero
		{2, errCell}, // not a number
	} {
		if got := s.Display(c.row, 2); got != c.want {
			t.Errorf("row %d = %q, want %q", c.row, got, c.want)
		}
	}
}

// An expression names columns the way a person does, so a name that means two
// columns means nothing the graph can reason about.
func TestAnAmbiguousColumnNameIsRefusedRatherThanGuessedAt(t *testing.T) {
	s := New("t.csv",
		[]string{"total", "total", "out"},
		[][]string{{"1", "2", ""}},
	)

	if err := s.Bind(2, parse(t, "total + 1")); err == nil {
		t.Fatal("a formula reading an ambiguous header was accepted")
	}
}

// A formula naming a column that is not there is refused before anything is
// computed, rather than filling 4,812 rows with a failure.
func TestAFormulaNamingAColumnThatIsNotThereIsRefused(t *testing.T) {
	s := sales(t)

	if err := s.Bind(3, parse(t, "price - postage")); err == nil {
		t.Fatal("a formula reading an absent column was accepted")
	}
	if s.EditCount() != 0 {
		t.Error("the refused binding was recorded")
	}
}

// A chain recomputes in dependency order, so a column that reads a bound column
// reads the value it computed and not the empty cell underneath it.
func TestAColumnThatReadsABoundColumnSeesWhatItComputed(t *testing.T) {
	s := New("t.csv",
		[]string{"units", "price", "revenue", "tax"},
		[][]string{{"10", "3", "", ""}, {"4", "5", "", ""}},
	)
	if err := s.Bind(2, parse(t, "units * price")); err != nil {
		t.Fatalf("Bind revenue: %v", err)
	}
	if err := s.Bind(3, parse(t, "revenue / 10")); err != nil {
		t.Fatalf("Bind tax: %v", err)
	}

	if got, want := s.Display(0, 3), "3"; got != want {
		t.Errorf("tax = %q, want %q", got, want)
	}

	// And the chain holds when the far end of it moves.
	if err := s.Set(0, 0, "20"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if got, want := s.Display(0, 3), "6"; got != want {
		t.Errorf("tax after editing units = %q, want %q", got, want)
	}
}

// Replaying the log rebuilds every computed value, which is what lets the file
// carry one expression instead of a column of results.
func TestReplayRebuildsWhatWasComputed(t *testing.T) {
	s := sales(t)
	if err := s.Bind(3, parse(t, "price - cost")); err != nil {
		t.Fatalf("Bind: %v", err)
	}
	if err := s.Set(0, 2, "10.00"); err != nil {
		t.Fatalf("Set: %v", err)
	}

	replayed := sales(t)
	if err := replayed.Replay(s.Edits()); err != nil {
		t.Fatalf("Replay: %v", err)
	}

	for row := 0; row < s.Rows(); row++ {
		if got, want := replayed.Display(row, 3), s.Display(row, 3); got != want {
			t.Errorf("replayed row %d = %q, want %q", row, got, want)
		}
	}
}

// Undo is truncate-and-replay, so a binding has to come back out the way any
// other operation does. This is the reason a binding is a log line and not a
// line of sheet state, which Ctrl+Z could never have reached.
func TestABindingCanBeUndone(t *testing.T) {
	s := sales(t)
	if err := s.Bind(3, parse(t, "price - cost")); err != nil {
		t.Fatalf("Bind: %v", err)
	}

	undone := sales(t)
	if err := undone.Replay(s.Edits()[:0]); err != nil {
		t.Fatalf("Replay: %v", err)
	}

	if got := undone.Display(0, 3); got != "" {
		t.Errorf("Display = %q, want the column unbound again", got)
	}
	if _, bound := undone.Binding(3); bound {
		t.Error("the column is still bound after the binding was replayed away")
	}
}

// The badge over a bound column has to describe what a person can see in it.
// Reading the stored values would call a column of numbers text, because a
// derived column stores nothing at all.
func TestABoundColumnIsNamedForWhatItComputes(t *testing.T) {
	s := sales(t)
	if err := s.Bind(3, parse(t, "price - cost")); err != nil {
		t.Fatalf("Bind: %v", err)
	}

	if got := s.Columns[3].Kind; got != KindNum {
		t.Errorf("kind = %v, want num", got)
	}
}

// Display runs about two hundred times a frame, so it has to be a read. A cache
// that allocated per cell would put the garbage collector on the scroll path,
// which is the cost the whole seam exists to avoid.
func BenchmarkDisplay(b *testing.B) {
	s := New("t.csv",
		[]string{"price", "cost", "margin"},
		[][]string{{"40.00", "31.20", ""}, {"40.00", "30.00", ""}},
	)
	f, err := formula.Parse("(price - cost) / price")
	if err != nil {
		b.Fatalf("Parse: %v", err)
	}
	if err := s.Bind(2, f); err != nil {
		b.Fatalf("Bind: %v", err)
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = s.Display(i%2, 2) // the bound column
		_ = s.Display(i%2, 0) // and one that falls through to Raw
	}
}
