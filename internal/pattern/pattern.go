// Package pattern watches what someone has already done to a column and works
// out what they meant, so the app can offer to do the rest.
//
// It observes the edit log and nothing else. The log is the record of what was
// done, the format a workspace is saved in, and the examples this package learns
// from, all at once — which is why a recogniser needs no channel of its own and
// no state that could fall out of step with the data.
//
// Nothing here decides anything. Propose returns a question; applying the answer
// is sheet.Apply, and only a person reaches it.
package pattern

import (
	"regexp"
	"slices"
	"strings"

	"github.com/flacyak/uno/internal/program"
	"github.com/flacyak/uno/internal/sheet"
)

// MinExamples is how many consistent changes make a question worth asking. Two
// is a coincidence often enough to be annoying; the third is the one that says
// this is a habit and not a typo.
const MinExamples = 3

// SampleSize bounds the preview. Twenty rows is more than anyone reads and few
// enough to build without measuring.
const SampleSize = 20

// maxRanked bounds the programs that get scored against the whole column.
// Scoring is the only part of this that touches every row, and the candidates
// past the first few dozen are refinements of each other.
const maxRanked = 32

// Change is one cell a proposal would alter, for the preview to show.
type Change struct {
	Row      int
	Was, Now string
}

// Proposal is the question. It carries what it would do and how much of it,
// because a person cannot agree to a transformation they have only been told the
// name of.
type Proposal struct {
	Col    int
	Header string
	Prog   program.Program

	// Affects is how many cells would change, not counting the ones already
	// fixed by hand — those are the examples, and offering to redo them would be
	// counting the person's own work as the app's.
	Affects int

	Sample []Change

	// Ambiguous marks a proposal whose runner-up disagrees with it somewhere in
	// the column. The examples do not settle which was meant, so the offer leads
	// with the preview rather than with the button: a guess that says it is a
	// guess is worth making, and one that does not is not.
	Ambiguous bool
}

// example is one demonstrated change: what a cell held before the person touched
// it, and what they left in it.
type example struct{ was, now string }

// column is one column's worth of a snapshot.
type column struct {
	col      int
	header   string
	values   []string
	examples []example
}

// Snapshot is the copy a scan runs over. The values are taken on the UI
// goroutine and the scan happens on a worker, because counting matches across a
// few thousand rows is felt in a scroll and I-7 does not allow reading the sheet
// from anywhere else.
//
// Only columns with enough examples to ask about are copied, so a snapshot taken
// after an ordinary edit is usually empty and costs nothing.
type Snapshot struct{ cols []column }

// Empty reports whether there is anything to scan, so a caller can skip starting
// a goroutine that would have nothing to do.
func (sn Snapshot) Empty() bool { return len(sn.cols) == 0 }

// Snap copies what Propose will need.
func Snap(s *sheet.Sheet) Snapshot {
	if s == nil {
		return Snapshot{}
	}

	byCol := gather(s.Edits())

	var sn Snapshot
	for col := 0; col < s.Cols(); col++ {
		ex := byCol[col]
		if len(ex) < MinExamples {
			continue
		}
		vals := make([]string, s.Rows())
		for row := range vals {
			vals[row] = s.Raw(row, col)
		}
		sn.cols = append(sn.cols, column{
			col:      col,
			header:   s.Columns[col].Header,
			values:   vals,
			examples: ex,
		})
	}
	return sn
}

// Propose returns the strongest question the snapshot supports, or false for
// none. One at a time: a person asked two questions about their spreadsheet at
// once answers neither.
func (sn Snapshot) Propose() (Proposal, bool) {
	for _, c := range sn.cols {
		if p, ok := c.propose(); ok {
			return p, true
		}
	}
	return Proposal{}, false
}

// witness is the two ways to read a set of examples: one at a time, whose
// candidate sets are intersected, and all at once, whose candidates are not.
// Intersecting asks what the examples have in common, which is the right
// question and the whole of the design — but a column whose decoration only some
// rows wear has its answer in their union instead. together is nil for a witness
// with no such reading.
type witness struct {
	each     func(was, now string) []string
	together func(ex []example) []string
}

// witnesses are tried in order, and the first that yields a proposal for this
// column wins.
//
// The order is the point. Rewrites and restructurings are different readings of
// the same edit — deleting the separators from 1,204 and slicing four characters
// out of it agree on that row and on nothing after it — and a column where
// characters changed is almost always a column where characters were meant to
// change. Falling back a whole column at a time rather than a single example at
// a time is what keeps one reading from answering for the other: three cells
// that each look like a deletion in isolation, and like nothing together, are a
// column the second reading should still get to look at.
var witnesses = []witness{
	{each: rewrites, together: unionDeletion},
	{each: restructures},
}

func (c column) propose() (Proposal, bool) {
	for _, w := range witnesses {
		if p, ok := c.proposeFrom(w); ok {
			return p, true
		}
	}
	// Two steps where one will not do. The ranking comparator sorts by step
	// count first, so a one-step program keeps its precedence and this is only
	// ever reached by a column no single step explains.
	return c.rank(compose(c.examples))
}

// maxFirstSteps bounds the fan-out. Each candidate costs a full induction over
// every example.
const maxFirstSteps = 8

// compose builds the two-step programs, by clearing characters first and reading
// what is left second. The first step comes from the characters the examples
// lost rather than from a lattice that has to explain them, and what it leaves
// is a shape the second step reads the same way in every row: (1,204) and (87)
// have no decomposition in common until the comma is gone, and 1.204,50 and
// 9.870,25 have no substitution in common until the full stop is.
func compose(ex []example) []program.Program {
	chars := droppedChars(ex)
	if len(chars) == 0 || len(chars) > maxFirstSteps {
		return nil
	}

	firsts := make([]string, 0, len(chars)+1)
	for _, r := range chars {
		firsts = append(firsts, replaceSrc(regexp.QuoteMeta(string(r)), ""))
	}
	if len(chars) > 1 {
		firsts = append(firsts, replaceSrc("["+quoteClass(chars)+"]", ""))
	}

	var out []program.Program
	for _, first := range parseAll(firsts) {
		rest := make([]example, len(ex))
		for i, e := range ex {
			rest[i] = example{was: first.Apply(e.was), now: e.now}
		}
		for _, w := range witnesses {
			for _, second := range induce(rest, w.each) {
				if len(first)+len(second) > program.MaxSteps {
					continue
				}
				out = append(out, append(slices.Clone(first), second...))
			}
		}
	}
	return out
}

func (c column) proposeFrom(w witness) (Proposal, bool) {
	cands := induce(c.examples, w.each)
	if w.together != nil {
		cands = append(cands, parseAll(w.together(c.examples))...)
	}
	return c.rank(cands)
}

// rank keeps the candidates that reproduce the examples and returns the best of
// them as the question to ask.
func (c column) rank(cands []program.Program) (Proposal, bool) {
	// Verification is separate from induction on purpose. A witness function
	// that generalises too far is a bug that shows up here as a candidate that
	// does not reproduce an example, and it is dropped rather than ranked down:
	// a program that cannot reproduce what it was induced from has no claim on
	// anything else in the column.
	//
	// The two readings can land on the same program, and a duplicate at the top
	// of the ranking would compare a program with itself and report a column
	// unambiguous that is not.
	var kept []program.Program
	seen := map[string]bool{}
	for _, p := range cands {
		if s := p.String(); !seen[s] && c.explains(p) {
			seen[s] = true
			kept = append(kept, p)
		}
	}
	if len(kept) == 0 {
		return Proposal{}, false
	}

	slices.SortFunc(kept, bySize)
	if len(kept) > maxRanked {
		kept = kept[:maxRanked]
	}

	type scored struct {
		p program.Program
		n int
		s []Change
	}

	var ranked []scored
	for _, p := range kept {
		n, sample := survey(p, c.values)
		if n == 0 {
			continue // it explains the examples and claims nothing else
		}
		ranked = append(ranked, scored{p: p, n: n, s: sample})
	}
	if len(ranked) == 0 {
		return Proposal{}, false
	}

	// Fewest steps, then fewest cells claimed. Preferring the narrowest program
	// that still explains every example is the guard against reading one habit
	// as a licence to rewrite a column: given the choice between "remove the
	// commas" and "remove the commas and the digits", both of which fit, the
	// smaller claim wins.
	slices.SortStableFunc(ranked, func(a, b scored) int {
		if d := len(a.p) - len(b.p); d != 0 {
			return d
		}
		if d := a.n - b.n; d != 0 {
			return d
		}
		return strings.Compare(a.p.String(), b.p.String())
	})

	top := ranked[0]
	return Proposal{
		Col:       c.col,
		Header:    c.header,
		Prog:      top.p,
		Affects:   top.n,
		Sample:    top.s,
		Ambiguous: len(ranked) > 1 && c.disagree(top.p, ranked[1].p),
	}, true
}

func (c column) explains(p program.Program) bool {
	for _, e := range c.examples {
		if p.Apply(e.was) != e.now {
			return false
		}
	}
	return true
}

// disagree reports whether two programs would do different things anywhere in
// this column. Two spellings of the same transformation are not an ambiguity,
// however different they look; two transformations that part company on row 400
// are, however similar.
func (c column) disagree(a, b program.Program) bool {
	for _, v := range c.values {
		if a.Apply(v) != b.Apply(v) {
			return true
		}
	}
	return false
}

func bySize(a, b program.Program) int {
	if d := len(a) - len(b); d != 0 {
		return d
	}
	return strings.Compare(a.String(), b.String())
}

// survey counts what a program would change and collects the first few for the
// preview. A cell the program leaves alone is a cell it does not claim, so the
// count is exactly the number of cells the person is being asked about.
func survey(p program.Program, values []string) (int, []Change) {
	var (
		n      int
		sample []Change
	)
	for row, v := range values {
		out := p.Apply(v)
		if out == v {
			continue
		}
		n++
		if len(sample) < SampleSize {
			sample = append(sample, Change{Row: row, Was: v, Now: out})
		}
	}
	return n, sample
}

// cell is one position, for gathering examples per cell rather than per edit.
type cell struct{ row, col int }

// gather reads the log back into the changes it describes.
//
// A cell edited twice contributes one example, from what it held before the
// first edit to what it holds after the last: the net change is what was meant,
// and the intermediate value was a keystroke. Edits need not be adjacent in the
// log — someone fixing a column will wander off to another one and come back,
// and a recogniser that only reads the tail would never see the pattern.
//
// An apply on a column clears its examples. The values those edits recorded no
// longer exist, and generalising from them again would be inducing a rule from
// the results of a rule.
func gather(log []sheet.Edit) map[int][]example {
	var (
		first = map[cell]string{}
		last  = map[cell]string{}
		order = map[int][]cell{}
	)

	for _, e := range log {
		switch e.Op {
		case sheet.OpApply:
			for _, c := range order[e.Col] {
				delete(first, c)
				delete(last, c)
			}
			delete(order, e.Col)

		case sheet.OpSet:
			c := cell{row: e.Row, col: e.Col}
			if _, seen := first[c]; !seen {
				first[c] = e.Was
				order[e.Col] = append(order[e.Col], c)
			}
			last[c] = e.Now
		}
	}

	out := map[int][]example{}
	for col, cells := range order {
		for _, c := range cells {
			// A value typed and then typed back is not a demonstration.
			if first[c] == last[c] {
				continue
			}
			out[col] = append(out[col], example{was: first[c], now: last[c]})
		}
	}
	return out
}
