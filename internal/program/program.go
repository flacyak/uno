// Package program is uno's transform language: the small string program a
// pattern proposal names, and the one an .uno log stores.
//
// It is its own package rather than part of sheet because its text form is
// public API. A program written into edits/log.jsonl has to be readable years
// from now by a build whose synthesiser has been rewritten, or removed
// entirely, so what the log carries is the program itself and replay is
// interpretation rather than a second guess at it. Nothing here knows what a
// sheet is.
package program

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// MaxSteps bounds a pipeline. The limit is not about cost — three steps run in
// nanoseconds — but about what a person can be shown in a banner and agree to
// in one reading. A proposal nobody can check is not a proposal.
const MaxSteps = 3

// MaxParts bounds a concat, for the same reason and to the same end: a
// rearrangement of more than four pieces is not one a banner can put a question
// about.
const MaxParts = 4

// Program is a pipeline applied left to right. The zero Program is valid and
// changes nothing, which is what lets a caller treat "no transform" as a
// program rather than as a special case.
type Program []Step

// Step is one stage of a pipeline.
type Step interface {
	// run reports false when the step does not apply to this value — a slice
	// whose bracket is missing, say. Programs are induced from a handful of rows
	// and then run over thousands, so meeting a value the program was not induced
	// from is ordinary, and it is not an error.
	run(string) (string, bool)

	// String renders the step back into the text form Parse accepts, so a
	// program that made a round trip through a file is the same program.
	String() string

	describe() string
}

// Apply runs the pipeline over one value.
//
// A program applies wholly or not at all: a step that does not fit abandons the
// whole pipeline and the original value is returned. Half-transforming a cell —
// trimming it and then failing to slice it — would leave data in a state no
// program describes, and would make the count of affected cells a guess.
func (p Program) Apply(v string) string {
	out := v
	for _, s := range p {
		var ok bool
		if out, ok = s.run(out); !ok {
			return v
		}
	}
	return out
}

func (p Program) String() string {
	parts := make([]string, len(p))
	for i, s := range p {
		parts[i] = s.String()
	}
	return strings.Join(parts, " | ")
}

// Describe names the program in the plain language a banner asks the question
// in. It falls back to the program text for anything it cannot name, which is
// the honest answer: a person asked to approve a transformation is better shown
// a notation they can learn than a description that glosses over what it does.
func (p Program) Describe() string {
	if len(p) == 0 {
		return "change nothing"
	}
	parts := make([]string, len(p))
	for i, s := range p {
		parts[i] = s.describe()
	}
	return strings.Join(parts, ", then ")
}

// Parse reads the text form. Regexes compile here rather than at apply time, so
// a damaged log fails at Replay with the line that broke it instead of halfway
// through rewriting a column.
func Parse(src string) (Program, error) {
	p := &parser{s: []rune(src)}

	var out Program
	for {
		st, err := p.step()
		if err != nil {
			return nil, fmt.Errorf("program %q: %w", src, err)
		}
		out = append(out, st)
		p.space()
		if !p.accept('|') {
			break
		}
	}

	p.space()
	if p.i < len(p.s) {
		return nil, fmt.Errorf("program %q: unexpected %q at character %d",
			src, string(p.s[p.i]), p.i+1)
	}
	if len(out) > MaxSteps {
		return nil, fmt.Errorf("program %q: %d steps, and the limit is %d",
			src, len(out), MaxSteps)
	}
	return out, nil
}

// Replace builds a substitution step, and is how the synthesiser proposes one
// without going through the text form.
func Replace(re, lit string) (Step, error) {
	c, err := regexp.Compile(re)
	if err != nil {
		return nil, fmt.Errorf("pattern /%s/: %w", re, err)
	}
	return replaceStep{re: c, src: re, lit: lit}, nil
}

// replaceStep rewrites every occurrence. Every rather than the first, because a
// value carrying two separators is the case a single-shot replace gets wrong
// and a person reading a banner would never expect it to.
type replaceStep struct {
	re  *regexp.Regexp
	src string
	lit string
}

// run substitutes literally: a replacement is text, not a template. $1 in a
// value someone typed has to survive being written back.
func (s replaceStep) run(v string) (string, bool) {
	return s.re.ReplaceAllLiteralString(v, s.lit), true
}

func (s replaceStep) String() string {
	return fmt.Sprintf("replace(%s, %s)", quoteRegex(s.src), strconv.Quote(s.lit))
}

func (s replaceStep) describe() string {
	what, ok := nameChars(s.src)
	if !ok {
		lit, isLit := literalOf(s.src)
		if !isLit {
			return s.String()
		}
		what = strconv.Quote(lit)
	}
	if s.lit == "" {
		return "remove " + what
	}
	return fmt.Sprintf("replace %s with %q", what, s.lit)
}

type trimStep struct{}

func (trimStep) run(v string) (string, bool) { return strings.TrimSpace(v), true }
func (trimStep) String() string              { return "trim()" }
func (trimStep) describe() string            { return "trim the spaces off both ends" }

type caseStep struct{ up bool }

func (s caseStep) run(v string) (string, bool) {
	if s.up {
		return strings.ToUpper(v), true
	}
	return strings.ToLower(v), true
}

func (s caseStep) String() string {
	if s.up {
		return "upper()"
	}
	return "lower()"
}

func (s caseStep) describe() string {
	if s.up {
		return "upper-case it"
	}
	return "lower-case it"
}

// sliceStep keeps what lies between two positions. It works in runes rather
// than bytes: a column of names is as likely to hold é as it is to hold e, and
// a transform that cuts one in half is worse than no transform.
type sliceStep struct{ from, to pos }

func (s sliceStep) run(v string) (string, bool) {
	r := []rune(v)
	a, ok := s.from.resolve(v, r)
	if !ok {
		return "", false
	}
	b, ok := s.to.resolve(v, r)
	if !ok {
		return "", false
	}
	a, b = clamp(a, len(r)), clamp(b, len(r))
	if a >= b {
		return "", true
	}
	return string(r[a:b]), true
}

func (s sliceStep) String() string {
	return fmt.Sprintf("slice(%s, %s)", s.from, s.to)
}

func (s sliceStep) describe() string { return s.String() }

func clamp(i, n int) int { return min(max(i, 0), n) }

// concatStep builds a value out of pieces of the old one and constants between
// them. It is what a slice on its own cannot do: pulling two fields out of a
// cell and putting them back in the other order changes no characters, only
// where they sit, and no amount of replacing expresses that.
//
// A part that does not fit abandons the whole step rather than contributing an
// empty string, because a name reassembled from the half of it that parsed is a
// worse answer than the name that was already there.
type concatStep struct{ parts []Step }

func (s concatStep) run(v string) (string, bool) {
	var b strings.Builder
	for _, p := range s.parts {
		out, ok := p.run(v)
		if !ok {
			return "", false
		}
		b.WriteString(out)
	}
	return b.String(), true
}

func (s concatStep) String() string {
	parts := make([]string, len(s.parts))
	for i, p := range s.parts {
		parts[i] = p.String()
	}
	return "concat(" + strings.Join(parts, ", ") + ")"
}

func (s concatStep) describe() string { return s.String() }

// constStep is a literal piece of a concat. It is not a step a pipeline can
// hold on its own: a program that ignores its input and returns a constant
// would set every cell in a column to the same value, which is a thing to type,
// not a thing to infer.
type constStep struct{ lit string }

func (s constStep) run(string) (string, bool) { return s.lit, true }
func (s constStep) String() string            { return strconv.Quote(s.lit) }
func (s constStep) describe() string          { return s.String() }

// pos is one end of a slice.
type pos interface {
	// resolve returns a rune offset into r. It reports false when the position
	// does not exist in this value, which is how a slice leaves alone a row that
	// does not look like the rows it was induced from.
	resolve(v string, r []rune) (int, bool)
	String() string
}

// idxPos counts characters, negative from the end, so slice(0, -1) drops a
// trailing character whatever the value's length.
type idxPos struct{ k int }

func (p idxPos) resolve(_ string, r []rune) (int, bool) {
	if p.k < 0 {
		return len(r) + p.k, true
	}
	return p.k, true
}

func (p idxPos) String() string { return strconv.Itoa(p.k) }

// lenPos is the end of the value, and exists because no index can say it.
// Counting back from the end gives -1 the character before the last one, which
// is what a reader of slice(0, -1) expects it to mean, so "as far as it goes"
// needs a word of its own rather than an off-by-one convention.
type lenPos struct{}

func (lenPos) resolve(_ string, r []rune) (int, bool) { return len(r), true }
func (lenPos) String() string                         { return "len" }

// matchPos is the boundary of the k-th match of a pattern, 1-based, and
// negative from the end. It is what makes a slice generalise: "after the first
// open bracket" holds across rows where a character count does not.
type matchPos struct {
	re    *regexp.Regexp
	src   string
	k     int
	atEnd bool
}

func (p matchPos) resolve(v string, r []rune) (int, bool) {
	m := p.re.FindAllStringIndex(v, -1)
	i := p.k - 1
	if p.k < 0 {
		i = len(m) + p.k
	}
	if i < 0 || i >= len(m) {
		return 0, false
	}
	at := m[i][0]
	if p.atEnd {
		at = m[i][1]
	}
	return runeOffset(v, at), true
}

func (p matchPos) String() string {
	name := "start"
	if p.atEnd {
		name = "end"
	}
	return fmt.Sprintf("%s(%s, %d)", name, quoteRegex(p.src), p.k)
}

// runeOffset converts a byte offset, which is what the regexp package reports,
// into the rune offset the slice arithmetic is done in.
func runeOffset(v string, b int) int {
	n := 0
	for i := range v {
		if i >= b {
			return n
		}
		n++
	}
	return n
}
