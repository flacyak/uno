package formula

import (
	"errors"
	"strings"
	"testing"
)

// row is the whole of what an evaluator needs from a sheet, which is the point
// of the Row interface: this test holds no sheet, and neither does the package.
type row map[string]string

func (r row) Value(col string) (string, bool) {
	v, ok := r[col]
	return v, ok
}

// The preview in the editor evaluates row one as a person types, so the
// arithmetic has to be the arithmetic they wrote: precedence, their brackets,
// and cells read through the same coercion the numeric badge promised.
func TestEvalComputesWhatWasWritten(t *testing.T) {
	sample := row{
		"units": "120",
		"price": "40.00",
		"cost":  "31.20",
		"gross": "1,204.50", // decorated, and still a number
		"blank": "",
		"label": "West",
	}

	for _, c := range []struct {
		src  string
		want float64
	}{
		{`1 + 2`, 3},
		{`units * price`, 4800},
		{`price - cost`, 8.80},
		{`(price - cost) / price`, 0.22},
		{`price - cost / price`, 40 - 31.20/40}, // precedence, not left to right
		{`(1 + 2) * 3`, 9},
		{`1 + 2 * 3`, 7},
		{`10 - 3 - 2`, 5}, // left-associative
		{`-price`, -40},
		{`-(price - cost)`, -8.80},
		{`gross / 2`, 602.25},
		{`0 - -1`, 1},
	} {
		t.Run(c.src, func(t *testing.T) {
			f, err := Parse(c.src)
			if err != nil {
				t.Fatalf("Parse: %v", err)
			}
			got, err := f.Eval(sample)
			if err != nil {
				t.Fatalf("Eval: %v", err)
			}
			// Binary floats, so compare within a tolerance no cell displays.
			if diff := got - c.want; diff > 1e-9 || diff < -1e-9 {
				t.Errorf("Eval = %v, want %v", got, c.want)
			}
		})
	}
}

// A per-cell failure has to be reportable, and it has to name the column. The
// sentinel is what the caller branches on; the wrapped text is what it shows.
// This is deliberately unlike program.Apply, which returns the original value
// and says nothing, because a program meets rows it was never induced from and
// a formula meets a column a person chose.
func TestEvalReportsWhichColumnFailedAndWhy(t *testing.T) {
	sample := row{
		"price": "40.00",
		"cost":  "n/a",
		"blank": "",
		"zero":  "0",
	}

	for _, c := range []struct {
		src  string
		want error
		name string
	}{
		{`price * quantity`, ErrUnknownColumn, "quantity"},
		{`price - cost`, ErrNotNumber, "cost"},
		{`price - blank`, ErrNotNumber, "blank"},
		{`price / zero`, ErrDivideByZero, "zero"},
		{`price / (zero * 2)`, ErrDivideByZero, "zero"},
		{`price / 0`, ErrDivideByZero, "0"},
	} {
		t.Run(c.src, func(t *testing.T) {
			f, err := Parse(c.src)
			if err != nil {
				t.Fatalf("Parse: %v", err)
			}
			_, err = f.Eval(sample)
			if !errors.Is(err, c.want) {
				t.Fatalf("Eval error = %v, want %v", err, c.want)
			}
			if !strings.Contains(err.Error(), c.name) {
				t.Errorf("Eval error = %q, want it to name %q", err, c.name)
			}
		})
	}
}

// A binding read out of a state.json some other build wrote can be empty. It
// has to fail on the path that evaluates it rather than take the window down.
func TestEvalOfTheZeroFormulaFailsRatherThanPanics(t *testing.T) {
	var f Formula
	if _, err := f.Eval(row{}); err == nil {
		t.Error("Eval of the zero Formula = nil error, want one")
	}
}
