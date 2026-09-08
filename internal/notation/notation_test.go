package notation

import (
	"strings"
	"testing"
)

// The subset, expression by expression. This is the design note's own evidence
// table, amended where the font test overruled it: \sum and \sqrt are gone from
// what can be drawn, so what stayed had to be written down again rather than
// carried over on trust.
//
// Rendering and acceptance are checked together on purpose. Two tables would
// let a source drift into being drawn one way and refused for another.
func TestTheSubsetDrawsTheNotationAPersonTypes(t *testing.T) {
	for _, c := range []struct {
		src, want string
	}{
		{"x^2", "x²"},
		{"x_1", "x₁"},
		{"e^{x}", "eˣ"},
		{"x^{10}", "x¹⁰"},   // a group, because a bare ^ takes one character
		{"x^{n+1}", "xⁿ⁺¹"}, // the plus is raised too, or the exponent is two sizes
		{"T_{max}", "Tₘₐₓ"},
		{`\alpha + \beta`, "α + β"},
		{`\pm \times \div`, "± × ÷"},
		{`\Sigma \mu \Omega`, "Σ μ Ω"},
		{`\frac{a}{b}`, "a⁄b"},
		{`\frac{x^2}{y_1}`, "x²⁄y₁"}, // a group is rendered, not copied
		{`\sigma = \frac{1}{n}`, "σ = 1⁄n"},
		{"(a+b)^{2}", "(a+b)²"},
		{`\mu_i`, "μᵢ"},
		{"revenue", "revenue"}, // a cell with no notation in it is left alone
		{"", ""},
	} {
		t.Run(c.src, func(t *testing.T) {
			if got := Render(c.src); got != c.want {
				t.Errorf("Render = %q, want %q", got, c.want)
			}
			if err := Supported(c.src); err != nil {
				t.Errorf("Supported refused what Render drew: %v", err)
			}
		})
	}
}

// The editor's whole promise: a symbol outside the subset is refused by name at
// authoring time, never discovered later as an empty box. An error that failed
// to name the symbol would leave a person hunting through their own expression
// for whichever part of it uno meant.
func TestSupportedNamesTheFirstSymbolItCannotDraw(t *testing.T) {
	for _, c := range []struct {
		src, names string
	}{
		{"x_q", `"q"`}, // 14 of the 26 subscript letters do not exist
		{"x_b", `"b"`},
		{"x_z", `"z"`},
		{`\sum_{i=1}^{n} x_i`, `\sum`}, // no glyph in the bundled font
		{`\sqrt{x^2+y^2}`, `\sqrt`},
		{`a \ne b`, `\ne`},
		{`\arctan`, `\arctan`}, // never in the subset at all
		{"x^", `"^"`},
		{"x_", `"_"`},
		{`\frac{a}`, `\frac`},
		{`a \ b`, `\ names no symbol`},
		{`x^{\alpha}`, `\alpha`}, // Greek has no raised form
		{`\frac{x_q}{b}`, `"q"`}, // inside a group counts as inside the source
		// First, not last: a person is being asked whether this cell can be
		// saved, and one symbol they can act on is the useful answer.
		{`x_q + \arctan`, `"q"`},
		{`\arctan + x_q`, `\arctan`},
	} {
		t.Run(c.src, func(t *testing.T) {
			err := Supported(c.src)
			if err == nil {
				t.Fatalf("Supported accepted %q", c.src)
			}
			if !strings.Contains(err.Error(), c.names) {
				t.Errorf("error %q does not name %s", err, c.names)
			}
		})
	}
}

// Render is total, and what it cannot draw it copies through. A .unof can be
// edited by hand and a later release can narrow the subset, so Render will meet
// sources Supported would refuse; a cell showing a backslash can be recovered
// from, and one that quietly swallowed half of what someone typed cannot.
func TestRenderKeepsWhatItCannotDraw(t *testing.T) {
	for _, c := range []struct {
		src, want string
	}{
		{"x_q", "x_q"},
		{`\arctan{x}`, `\arctan{x}`},
		{`\sqrt{x^2}`, `\sqrt{x²}`},         // refused, and still draws what it can
		{`\sum_{i=1}^{n}`, `\sumᵢ₌₁ⁿ`},      // the loss the font test caused, in full
		{`x^{\alpha} y_2`, `x^{\alpha} y₂`}, // the refused script survives whole
	} {
		t.Run(c.src, func(t *testing.T) {
			if got := Render(c.src); got != c.want {
				t.Errorf("Render = %q, want %q", got, c.want)
			}
		})
	}
}

// Every entry in the tables has to be reachable from something a person could
// type. A mistyped key is a symbol that is in the subset by the font test's
// reckoning and unreachable by anyone else's.
func TestEveryTableEntryIsReachableFromASource(t *testing.T) {
	for name, want := range symbols {
		src := `\` + name
		if got := Render(src); got != string(want) {
			t.Errorf("Render(%q) = %q, want %q", src, got, string(want))
		}
		if err := Supported(src); err != nil {
			t.Errorf("Supported(%q): %v", src, err)
		}
	}
	for _, c := range []struct {
		mark  string
		table map[rune]rune
	}{{"^", superscripts}, {"_", subscripts}} {
		for k, want := range c.table {
			src := "x" + c.mark + string(k)
			if got := Render(src); got != "x"+string(want) {
				t.Errorf("Render(%q) = %q, want %q", src, got, "x"+string(want))
			}
			if err := Supported(src); err != nil {
				t.Errorf("Supported(%q): %v", src, err)
			}
		}
	}
}

// The two tables answer separately, so nothing is both drawable and refused. A
// name in both would make Render and Supported disagree about the same cell.
func TestNoNameIsBothDrawableAndRefused(t *testing.T) {
	for name := range noGlyph {
		if r, ok := symbols[name]; ok {
			t.Errorf(`\%s is refused and also drawn as %U`, name, r)
		}
	}
}
