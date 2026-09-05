// Package notation turns the markdown a math cell stores into the text it
// shows: x^2 in, x² out.
//
// Three renderers were measured for M3 and the measurements chose this one.
// go-latex panics on every superscript and subscript tested, including a bare
// x^2, so a math feature built on it could not draw the one expression that
// makes notation worth having. goldmark-mathjax emits LaTeX wrapped in HTML for
// MathJax to lay out in a browser, and uno has neither a browser nor a
// JavaScript engine. What is left is spelling the notation with runes that
// already exist, which needs no dependency and has nothing to recover() from.
//
// The price is a narrow subset, and the whole design of this package is about
// being honest that it is narrow: Supported names the first symbol it cannot
// draw so the editor can refuse a cell at authoring time, rather than leaving a
// person to find a missing-glyph box in their sheet later.
//
// The subset turned out to be narrower than the design predicted. Unicode has
// no subscript b, which was expected; what was not is that Fyne v2.8.1 bundles
// a Noto Sans with no mathematical-operators block at all, so ∑, √, ∫, ∞, ≠, ≤
// and ≥ have codepoints and no glyphs. See the tables and the font test, which
// is what found it.
//
// Rendering happens once, when the cell is authored, so what leaves here is
// finished text and the grid goes on drawing a widget.Label. Nothing in the
// package imports Fyne; the one test that does reads the bundled font's bytes
// to check every rune these tables can emit really has a glyph, and reading
// them needs no display (I-6).
package notation

import (
	"fmt"
	"strings"
)

// Render transliterates the supported subset and never fails.
//
// A cell can only be saved once Supported has accepted it, so the source Render
// meets has already been checked. When it meets something it cannot draw anyway
// — a .unof edited by hand, a subset narrowed by a later release — it copies
// that piece through verbatim rather than dropping it. A cell showing a
// backslash is recoverable; a cell that silently swallowed part of what someone
// typed is not.
func Render(src string) string {
	s := &scanner{src: []rune(src)}
	s.run()
	return s.out.String()
}

// Supported names the first symbol the subset cannot draw.
//
// First rather than all of them: the editor is asking whether this cell can be
// saved, and one named symbol is what a person can act on. The error always
// names the symbol itself, because "unsupported notation" would send someone
// hunting through their own expression for it.
func Supported(src string) error {
	s := &scanner{src: []rune(src)}
	s.run()
	return s.err
}

// fracSlash renders \frac{a}{b} as a⁄b, on one line. A real fraction is
// stacked, which a line of text cannot be, so this is an approximation and is
// meant to read as one — not a pretence that the subset does fractions. It is
// the only rune this package emits that comes from no table.
const fracSlash = '⁄' // U+2044

// scanner walks the source once, building the rendered text and keeping the
// first complaint. One walk serves both entry points so that what Supported
// accepts is exactly what Render draws, which two separate passes would drift
// apart on the first table someone edited.
type scanner struct {
	src []rune
	i   int
	out strings.Builder
	err error
}

func (s *scanner) run() {
	for s.i < len(s.src) {
		switch c := s.src[s.i]; c {
		case '\\':
			s.command()
		case '^':
			s.script(superscripts, "superscript")
		case '_':
			s.script(subscripts, "subscript")
		default:
			s.out.WriteRune(c)
			s.i++
		}
	}
}

// command reads a backslash name and whatever groups it takes.
func (s *scanner) command() {
	start := s.i
	s.i++ // the backslash
	name := word(s.src[s.i:])
	s.i += len(name)

	switch name {
	case "":
		s.fail(`a lone \ names no symbol`)
		s.literal(start)
	case "frac":
		num, ok := s.group()
		den, ok2 := s.group()
		if !ok || !ok2 {
			s.fail("%s needs two {…} groups to draw", `\frac`)
			s.literal(start)
			return
		}
		s.out.WriteString(s.nested(num))
		s.out.WriteRune(fracSlash)
		s.out.WriteString(s.nested(den))
	default:
		if sym, ok := symbols[name]; ok {
			s.out.WriteRune(sym)
			return
		}
		// The complaint names the codepoint and never prints the rune: the
		// dialog carrying this message is drawn in the same font, so a message
		// about an empty box would contain one. Command names go through %s
		// rather than %q for the same reason of reading back what was typed —
		// %q would show \\sum for the \sum a person put in the cell.
		if r, ok := noGlyph[name]; ok {
			s.fail("%s is %U, which uno's font has no glyph for", `\`+name, r)
			s.literal(start)
			return
		}
		s.fail("%s is not a symbol uno can draw", `\`+name)
		s.literal(start)
	}
}

// script raises or lowers what follows a ^ or a _, in either the bare form x^2
// or the braced form e^{x}.
//
// Every rune of the group has to have a small form or none of it is drawn: half
// a raised exponent sitting next to a full-size character reads as a different
// expression from the one that was typed.
func (s *scanner) script(table map[rune]rune, kind string) {
	start := s.i
	mark := string(s.src[s.i])
	s.i++ // the ^ or the _

	content, ok := s.group()
	if !ok && s.i < len(s.src) {
		content, ok = s.src[s.i:s.i+1], true
		s.i++
	}
	if !ok || len(content) == 0 {
		s.fail("%q needs a symbol after it", mark)
		s.literal(start)
		return
	}

	var small strings.Builder
	for i, r := range content {
		if r == '\\' {
			// \alpha^{\beta}. Naming the command is more use to a person than
			// naming the backslash it happens to begin with.
			s.fail("%s has no %s form to draw", `\`+word(content[i+1:]), kind)
			s.literal(start)
			return
		}
		c, ok := table[r]
		if !ok {
			s.fail("%q has no %s form to draw", string(r), kind)
			s.literal(start)
			return
		}
		small.WriteRune(c)
	}
	s.out.WriteString(small.String())
}

// group takes a balanced {…} at the cursor and returns what is inside it,
// leaving the cursor untouched when there is no group to take. It counts depth
// so that \frac{1}{\frac{a}{b}} finds the closing brace that belongs to it.
func (s *scanner) group() ([]rune, bool) {
	if s.i >= len(s.src) || s.src[s.i] != '{' {
		return nil, false
	}
	depth := 0
	for j := s.i; j < len(s.src); j++ {
		switch s.src[j] {
		case '{':
			depth++
		case '}':
			if depth--; depth == 0 {
				inner := s.src[s.i+1 : j]
				s.i = j + 1
				return inner, true
			}
		}
	}
	return nil, false // unclosed, so there is no group here
}

// nested renders the inside of a group, folding its first complaint into this
// scanner's so that the symbol Supported names is the first one in the source
// and not the first one at the outermost level.
func (s *scanner) nested(inner []rune) string {
	n := &scanner{src: inner}
	n.run()
	s.failErr(n.err)
	return n.out.String()
}

// literal copies the source from start to the cursor through unrendered. See
// Render on why an unsupported piece survives rather than vanishing.
func (s *scanner) literal(start int) {
	s.out.WriteString(string(s.src[start:s.i]))
}

func (s *scanner) fail(format string, a ...any) { s.failErr(fmt.Errorf(format, a...)) }

func (s *scanner) failErr(err error) {
	if s.err == nil {
		s.err = err
	}
}

// word reads a command name: ASCII letters only, which is every name the subset
// has and stops \alpha+\beta at the plus.
func word(rs []rune) string {
	n := 0
	for n < len(rs) && (rs[n] >= 'a' && rs[n] <= 'z' || rs[n] >= 'A' && rs[n] <= 'Z') {
		n++
	}
	return string(rs[:n])
}
