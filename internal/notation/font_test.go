package notation

import (
	"testing"

	"fyne.io/fyne/v2/theme"
	"golang.org/x/image/font/sfnt"
)

// glyph names one rune a table can emit and where it came from, so a failure
// says which table to edit rather than only which codepoint is missing.
type glyph struct {
	where string
	r     rune
}

// emittable is every rune Render can produce. It is built from the tables
// themselves rather than typed out again, because a second list is a list that
// stops matching the first.
func emittable() []glyph {
	out := []glyph{{"\\frac", fracSlash}}
	for k, v := range superscripts {
		out = append(out, glyph{"superscript " + string(k), v})
	}
	for k, v := range subscripts {
		out = append(out, glyph{"subscript " + string(k), v})
	}
	for k, v := range symbols {
		out = append(out, glyph{`\` + k, v})
	}
	return out
}

// bundledFont parses the font Fyne draws a Label with. It reads the theme's
// embedded resource, so there is no app, no window and no display in it (I-6).
func bundledFont(t *testing.T) (*sfnt.Font, string) {
	t.Helper()
	res := theme.DefaultTextFont()
	f, err := sfnt.Parse(res.Content())
	if err != nil {
		t.Fatalf("parsing %s: %v", res.Name(), err)
	}
	return f, res.Name()
}

// The design left one caveat open: a codepoint existing is not the same as the
// bundled font having a glyph for it, so a rune Unicode defines and Noto does
// not would reach a cell as an empty box — the outcome Supported exists to
// prevent, arriving through the one door it does not watch. Asking the font
// pins the subset to a measurement rather than to a claim, and a rune this test
// rejects comes out of the table.
func TestEveryRuneTheTablesCanEmitHasAGlyphInTheBundledFont(t *testing.T) {
	f, name := bundledFont(t)

	var buf sfnt.Buffer
	for _, g := range emittable() {
		i, err := f.GlyphIndex(&buf, g.r)
		if err != nil {
			t.Fatalf("looking up %s (%U): %v", g.where, g.r, err)
		}
		if i == 0 {
			t.Errorf("%s renders %U, which %s has no glyph for", g.where, g.r, name)
		}
	}
}

// The same measurement in the other direction. noGlyph costs the subset \sum
// and \sqrt, which is a real loss, so it should not outlive the font that
// caused it: when a later Fyne bundles a font that has these, this test fails
// and the fix is to move them into symbols.
func TestNothingInTheRefusedListStillLacksAGlyph(t *testing.T) {
	f, name := bundledFont(t)

	var buf sfnt.Buffer
	for cmd, r := range noGlyph {
		i, err := f.GlyphIndex(&buf, r)
		if err != nil {
			t.Fatalf("looking up \\%s (%U): %v", cmd, r, err)
		}
		if i != 0 {
			t.Errorf(`%s now has a glyph for %U, so \%s belongs in symbols`, name, r, cmd)
		}
	}
}
