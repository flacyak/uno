package formula

import (
	"reflect"
	"testing"
)

// The text form is what a .uno and a .unof both carry, so an expression that
// has been through a file has to be the expression that went in.
func TestTheTextFormRoundTrips(t *testing.T) {
	for _, src := range []string{
		`units`,
		`1`,
		`40.00`,
		`units * price`,
		`price - cost`,
		`total / 2`,
		`(price - cost) / price`,
		`a + b * c`,
		`(a + b) * c`,
		`a - b - c`,
		`a - (b - c)`,
		`1 + 2 * 3 - 4 / 5`,
		`-price`,
		`-(a + b)`,
		`0 - -1`,
		`gross * (1 - tax_rate)`,
		`_private + n2`,
		`région * 2`,
	} {
		t.Run(src, func(t *testing.T) {
			f, err := Parse(src)
			if err != nil {
				t.Fatalf("Parse: %v", err)
			}
			if got := f.String(); got != src {
				t.Errorf("round trip = %q, want %q", got, src)
			}
			if _, err := Parse(f.String()); err != nil {
				t.Errorf("reparsing %q: %v", f, err)
			}
		})
	}
}

// String is a normal form rather than a transcription: spacing is the parser's
// to decide, but bracketing is the person's. Their brackets are how they show
// their working, and one this package removed would be an edit to an expression
// it was only asked to store.
func TestSpacingIsNormalisedAndBracketsAreKept(t *testing.T) {
	for _, c := range []struct{ src, want string }{
		{`units*price`, `units * price`},
		{`  units   *price `, `units * price`},
		{`(price-cost)/price`, `(price - cost) / price`},
		{`(a) + b`, `(a) + b`}, // redundant, and still theirs
		{`((a))`, `((a))`},     // twice redundant, and still theirs
		{`a + (b * c)`, `a + (b * c)`},
	} {
		t.Run(c.src, func(t *testing.T) {
			f, err := Parse(c.src)
			if err != nil {
				t.Fatalf("Parse: %v", err)
			}
			if got := f.String(); got != c.want {
				t.Errorf("String = %q, want %q", got, c.want)
			}
			if _, err := Parse(f.String()); err != nil {
				t.Errorf("reparsing %q: %v", f, err)
			}
		})
	}
}

// Refs is what the dependency graph is built out of, so a name it misses is an
// edge the graph does not have and a cycle it would accept. Sorted and
// deduplicated because the answer reaches a person, in a .unof's refs and in
// the path a refused binding names.
func TestRefsNamesEveryColumnReadOnce(t *testing.T) {
	for _, c := range []struct {
		src  string
		want []string
	}{
		{`units * price`, []string{"price", "units"}},
		{`(price - cost) / price`, []string{"cost", "price"}},
		{`-margin`, []string{"margin"}},
		{`a * (b + c) - a`, []string{"a", "b", "c"}},
		{`1 + 2 * 3`, []string{}},
		{`gross * (1 - tax_rate)`, []string{"gross", "tax_rate"}},
	} {
		t.Run(c.src, func(t *testing.T) {
			f, err := Parse(c.src)
			if err != nil {
				t.Fatalf("Parse: %v", err)
			}
			if got := f.Refs(); !reflect.DeepEqual(got, c.want) {
				t.Errorf("Refs = %v, want %v", got, c.want)
			}
		})
	}
}

// A stored expression this build cannot read must fail before a single cell
// moves, so everything that is not an expression has to be refused here rather
// than surviving to the row it breaks on.
func TestParseRefusesWhatItCannotRun(t *testing.T) {
	for _, src := range []string{
		``,
		`   `,
		`1 +`,
		`+ 1`,
		`* 2`,
		`a b`,
		`2x`,
		`(1 + 2`,
		`1 + 2)`,
		`()`,
		`a ** b`,
		`a / / b`,
		`1..2`,
		`1.`,
		`.5`,
		`1e3`,   // an exponent is not a thing a spreadsheet holds
		`1,204`, // decoration belongs to the cell, not to the expression
		`a $ b`,
		`"price"`,  // there is no quoting syntax, on purpose
		`Q3 (net)`, // a header that is not an identifier cannot be referenced
		`price * `,
	} {
		t.Run(src, func(t *testing.T) {
			if f, err := Parse(src); err == nil {
				t.Errorf("Parse(%q) = %v, want an error", src, f)
			}
		})
	}
}

// A binding can arrive out of a state.json written by another build. A missing
// expression has to be a value that fails, not a crash on the path that reads
// it.
func TestTheZeroFormulaIsEmptyRatherThanAPanic(t *testing.T) {
	var f Formula
	if got := f.String(); got != "" {
		t.Errorf("String = %q, want %q", got, "")
	}
	if got := f.Refs(); len(got) != 0 {
		t.Errorf("Refs = %v, want none", got)
	}
}
