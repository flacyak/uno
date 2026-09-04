package program

import "testing"

// The text form is what an .uno carries, so a program that has been through a
// file has to be the program that went in.
func TestTheTextFormRoundTrips(t *testing.T) {
	for _, src := range []string{
		`replace(/,/, "")`,
		`replace(/[$,]/, "")`,
		`replace(/\s+/, " ")`,
		`replace(/\//, "-")`,
		`trim()`,
		`upper()`,
		`lower()`,
		`slice(0, -1)`,
		`slice(end(/\(/, 1), start(/\)/, 1))`,
		`trim() | replace(/%$/, "")`,
		`trim() | replace(/,/, "") | upper()`,
	} {
		t.Run(src, func(t *testing.T) {
			p, err := Parse(src)
			if err != nil {
				t.Fatalf("Parse: %v", err)
			}
			if got := p.String(); got != src {
				t.Errorf("round trip = %q, want %q", got, src)
			}
			if _, err := Parse(p.String()); err != nil {
				t.Errorf("reparsing %q: %v", p, err)
			}
		})
	}
}

func TestApply(t *testing.T) {
	for _, c := range []struct {
		src, in, want string
	}{
		{`replace(/,/, "")`, "1,204", "1204"},
		{`replace(/,/, "")`, "1,204,567", "1204567"}, // every occurrence, not the first
		{`replace(/,/, "")`, "987", "987"},           // no match leaves it alone
		{`replace(/[$,]/, "")`, "$1,204", "1204"},
		{`replace(/%$/, "")`, "12%", "12"},
		{`replace(/%$/, "")`, "1%2", "1%2"}, // anchored, so the middle one stays
		{`trim()`, "  1204 ", "1204"},
		{`upper()`, "west", "WEST"},
		{`lower()`, "West", "west"},
		{`slice(0, -1)`, "1204x", "1204"},
		{`slice(1, 3)`, "abcde", "bc"},
		{`slice(end(/\(/, 1), start(/\)/, 1))`, "Ada (West)", "West"},
		{`slice(end(/\(/, 1), start(/\)/, 1))`, "Ada Okafor", "Ada Okafor"}, // no bracket, left alone
		{`trim() | replace(/,/, "")`, " 1,204 ", "1204"},
		{`slice(0, -1)`, "é1", "é"}, // runes, not bytes
	} {
		t.Run(c.src+"/"+c.in, func(t *testing.T) {
			p, err := Parse(c.src)
			if err != nil {
				t.Fatalf("Parse: %v", err)
			}
			if got := p.Apply(c.in); got != c.want {
				t.Errorf("Apply(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

// A replacement is text. A value someone typed that happens to read like a
// capture reference has to survive being written back.
func TestAReplacementIsLiteralText(t *testing.T) {
	p, err := Parse(`replace(/x/, "$1")`)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if got := p.Apply("x"); got != "$1" {
		t.Errorf("Apply = %q, want %q", got, "$1")
	}
}

// A log that does not parse must say so before a column is rewritten, not
// halfway through one.
func TestParseRefusesWhatItCannotRun(t *testing.T) {
	for _, src := range []string{
		``,
		`replace(/,/)`,
		`replace(/,/, "",)`,
		`replace(,, "")`,
		`replace(/[/, "")`, // an uncompilable pattern
		`explode()`,
		`trim`,
		`trim()) `,
		`replace(/,/, "") | `,
		`trim() | trim() | trim() | trim()`, // past MaxSteps
		`slice(0)`,
		`slice(start(/a/, 0), 1)`, // matches are counted from 1
		`replace(/,/, ")`,
		`replace(/,, "")`,
	} {
		t.Run(src, func(t *testing.T) {
			if p, err := Parse(src); err == nil {
				t.Errorf("Parse(%q) = %v, want an error", src, p)
			}
		})
	}
}

// The banner asks the question in words, so the words have to be right for what
// the recogniser actually proposes, and absent rather than approximate for the
// rest.
func TestDescribe(t *testing.T) {
	for _, c := range []struct{ src, want string }{
		{`replace(/,/, "")`, "remove commas"},
		{`replace(/[$,]/, "")`, "remove dollar signs and commas"},
		{`replace(/[$, ]/, "")`, "remove dollar signs, commas and spaces"},
		{`replace(/,/, ".")`, `replace commas with "."`},
		{`trim()`, "trim the spaces off both ends"},
		{`trim() | replace(/,/, "")`, "trim the spaces off both ends, then remove commas"},
		{`upper()`, "upper-case it"},

		// A literal the QuoteMeta in the lattice can be inverted out of, and the
		// anchored class rungs that lattice emits.
		{`replace(/ kg/, "")`, `remove " kg"`},
		{`replace(/SKU-/, "")`, `remove "SKU-"`},
		{`replace(/[*]+$/, "")`, "remove asterisks from the end"},
		{`replace(/^[#]+/, "")`, "remove hashes from the start"},
		{`replace(/\//, "-")`, `replace slashes with "-"`},
		{`replace(/[ ()\-]/, "")`, "remove spaces, brackets and dashes"},

		// Nothing in the vocabulary names these, so they fall back to notation
		// rather than to a description that glosses over what they do.
		{`replace(/\d/, "")`, `replace(/\d/, "")`},
		{`replace(/[^,]/, "")`, `replace(/[^,]/, "")`},
		{`replace(/\s+/, " ")`, `replace(/\s+/, " ")`},
		{`slice(0, -1)`, `slice(0, -1)`},
	} {
		t.Run(c.src, func(t *testing.T) {
			p, err := Parse(c.src)
			if err != nil {
				t.Fatalf("Parse: %v", err)
			}
			if got := p.Describe(); got != c.want {
				t.Errorf("Describe = %q, want %q", got, c.want)
			}
		})
	}
}

// A concat is what the other steps cannot do: the same characters in a
// different order.
func TestConcatRearranges(t *testing.T) {
	p, err := Parse(`concat(slice(end(/, /, 1), len), " ", slice(0, start(/,/, 1)))`)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if got, want := p.String(), `concat(slice(end(/, /, 1), len), " ", slice(0, start(/,/, 1)))`; got != want {
		t.Errorf("round trip = %q, want %q", got, want)
	}
	if got, want := p.Apply("Okafor, Ada"), "Ada Okafor"; got != want {
		t.Errorf("Apply = %q, want %q", got, want)
	}
}

// A part that does not fit abandons the whole step. A name reassembled from the
// half of it that parsed is a worse answer than the name already there.
func TestAConcatThatDoesNotFitLeavesTheValueAlone(t *testing.T) {
	p, err := Parse(`concat(slice(end(/, /, 1), len), " ", slice(0, start(/,/, 1)))`)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if got, want := p.Apply("Ada Okafor"), "Ada Okafor"; got != want {
		t.Errorf("Apply = %q, want %q", got, want)
	}
}

// A program applies wholly or not at all. Half-transforming a cell would leave
// data in a state no program describes.
func TestAPipelineThatBreaksPartWayThroughChangesNothing(t *testing.T) {
	p, err := Parse(`trim() | slice(start(/\(/, 1), 99)`)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if got, want := p.Apply("  no bracket  "), "  no bracket  "; got != want {
		t.Errorf("Apply = %q, want the untrimmed original %q", got, want)
	}
}

func TestConcatParseRefusals(t *testing.T) {
	for _, src := range []string{
		`concat("only")`,                  // one part is that part
		`concat(slice(0, 1))`,             // likewise
		`concat(trim(), "x")`,             // a part is a piece, not a step
		`concat("a", "b", "c", "d", "e")`, // past MaxParts
		`concat("a",)`,
	} {
		t.Run(src, func(t *testing.T) {
			if p, err := Parse(src); err == nil {
				t.Errorf("Parse(%q) = %v, want an error", src, p)
			}
		})
	}
}
