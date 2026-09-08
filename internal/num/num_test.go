package num

import "testing"

// Moved here from sheet, where the same rule was an unexported helper. The list
// is the point: ParseFloat alone accepts everything in the second group, and a
// column of them is not numeric data.
func TestIsNumberRejectsWhatASpreadsheetDoesNotMean(t *testing.T) {
	for _, v := range []string{"12", "-3.5", "+7", "1e3", "0.0"} {
		if !IsNumber(v) {
			t.Errorf("IsNumber(%q) = false, want true", v)
		}
	}
	// ParseFloat alone accepts all of these; a column of them is not numeric.
	for _, v := range []string{"inf", "NaN", "0x1p-2", "1,204", "", "12 "} {
		if IsNumber(v) {
			t.Errorf("IsNumber(%q) = true, want false", v)
		}
	}
}

// Undressing is what separates a number in a costume from text. It has to take
// the costume off and leave everything else on, because the full stop it does
// not strip is what keeps 3.5 a number and the letters it does not strip are
// what keep "N/A" out of a numeric column.
func TestUndressTakesOffTheCostumeAndNothingElse(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"1,204", "1204"},
		{"$1,204.50", "1204.50"},
		{"£40.00", "40.00"},
		{"€1 204", "1204"},
		{"12%", "12"},
		{"1'204", "1204"},
		{" 987 ", "987"},
		{"3.5", "3.5"},
		{"N/A", "N/A"},
		{"", ""},
	} {
		t.Run(c.in, func(t *testing.T) {
			if got := Undress(c.in); got != c.want {
				t.Errorf("Undress(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

// Parse is the coercion an evaluator runs per cell, so what it accepts decides
// which columns arithmetic can be bound to. It undresses first: a column of
// 1,204 is one people expect to multiply, and refusing it for wearing a comma
// would make the badge's promise a lie one screen later.
func TestParseReadsTheNumberAPersonSees(t *testing.T) {
	for _, c := range []struct {
		in   string
		want float64
		ok   bool
	}{
		{"12", 12, true},
		{"-3.5", -3.5, true},
		{"1,204", 1204, true},
		{"$1,204.50", 1204.50, true},
		{"£40.00", 40, true},
		{" 987 ", 987, true},

		// A percent sign is decoration, so 12% reads as the 12 that was
		// written. Dividing by a hundred here would invent a value nobody
		// typed and no cell displays.
		{"12%", 12, true},

		{"", 0, false},
		{"N/A", 0, false},
		{"inf", 0, false},
		{"NaN", 0, false},
		{"0x1p-2", 0, false},
		{"1.2.3", 0, false},
		{"12 ea", 0, false},
	} {
		t.Run(c.in, func(t *testing.T) {
			got, ok := Parse(c.in)
			if ok != c.ok {
				t.Fatalf("Parse(%q) ok = %v, want %v", c.in, ok, c.ok)
			}
			if ok && got != c.want {
				t.Errorf("Parse(%q) = %v, want %v", c.in, got, c.want)
			}
		})
	}
}
