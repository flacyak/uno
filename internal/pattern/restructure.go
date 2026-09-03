package pattern

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/flacyak/uno/internal/program"
)

// minPiece is the shortest run of characters taken as a piece of the old value
// rather than as a constant. One character that happens to appear in both is a
// coincidence; two are a quotation.
const minPiece = 2

// restructures induces the programs that move characters rather than change
// them: pulling a code out of the middle of a cell, or putting two fields back
// in the other order.
//
// It runs only when no rewrite fits, because the two readings of an edit are
// different intents. Stripping the separators from 1,204 and slicing four
// characters out of it agree on that row and on nothing after it.
func restructures(was, now string) []string {
	a, b := []rune(was), []rune(now)
	if len(a) > maxDiff || len(b) > maxDiff || was == now || len(b) == 0 {
		return nil
	}

	parts := decompose(a, b)
	if len(parts) == 0 || len(parts) > program.MaxParts {
		return nil
	}

	// A decomposition that quotes nothing describes setting the column to a
	// constant, which is a thing to type rather than a thing to infer.
	quoted := false
	sets := make([][]string, len(parts))
	for i, p := range parts {
		if !p.isSlice {
			sets[i] = []string{strconv.Quote(p.lit)}
			continue
		}
		quoted = true
		sets[i] = sliceSrcs(a, p.from, p.to)
	}
	if !quoted {
		return nil
	}

	combos := cross(sets)
	out := make([]string, 0, len(combos))
	for _, c := range combos {
		if len(c) == 1 {
			out = append(out, c[0]) // a lone slice is a step, not a concat of one
			continue
		}
		out = append(out, "concat("+strings.Join(c, ", ")+")")
	}
	return out
}

// piece is one stretch of the new value: either a constant the person typed, or
// a quotation from the old value.
type piece struct {
	lit      string
	from, to int
	isSlice  bool
}

// decompose reads the new value as a sequence of quotations from the old one
// with constants between them. It is greedy from the left, taking the longest
// quotation available at each point, which is what makes the same reading come
// back for the same pair of values every time.
func decompose(a, b []rune) []piece {
	var (
		parts []piece
		lit   strings.Builder
	)
	flush := func() {
		if lit.Len() > 0 {
			parts = append(parts, piece{lit: lit.String()})
			lit.Reset()
		}
	}

	for i := 0; i < len(b); {
		at, n := longestQuote(a, b[i:])
		if n < minPiece {
			lit.WriteRune(b[i])
			i++
			continue
		}
		flush()
		parts = append(parts, piece{from: at, to: at + n, isSlice: true})
		i += n
		if len(parts) > program.MaxParts {
			return nil
		}
	}
	flush()
	return parts
}

// longestQuote finds the longest prefix of rest that appears in a, and where.
func longestQuote(a, rest []rune) (at, n int) {
	limit := min(len(rest), len(a))
	for n = limit; n >= minPiece; n-- {
		if i := indexRunes(a, rest[:n]); i >= 0 {
			return i, n
		}
	}
	return 0, 0
}

func indexRunes(a, sub []rune) int {
	return runeOffsetOf(string(a), strings.Index(string(a), string(sub)))
}

func runeOffsetOf(s string, b int) int {
	if b < 0 {
		return -1
	}
	n := 0
	for i := range s {
		if i >= b {
			return n
		}
		n++
	}
	return n
}

// sliceSrcs is the lattice for one quotation: where its two ends could be said
// to be. A character count holds only for rows shaped exactly like this one, so
// each end also gets a description in terms of the delimiter beside it, which is
// the form that survives a row of a different length.
func sliceSrcs(a []rune, from, to int) []string {
	froms := []string{strconv.Itoa(from)}
	if from > 0 {
		froms = append(froms, strconv.Itoa(from-len(a)))
		froms = append(froms, boundary(a, from-1, "end")...)
	}

	tos := []string{}
	if to == len(a) {
		tos = append(tos, "len")
	} else {
		tos = append(tos, strconv.Itoa(to), strconv.Itoa(to-len(a)))
		tos = append(tos, boundary(a, to, "start")...)
	}

	out := make([]string, 0, len(froms)*len(tos))
	for _, f := range froms {
		for _, t := range tos {
			out = append(out, "slice("+f+", "+t+")")
		}
	}
	return out
}

// boundary describes a position by the character sitting at it: the k-th comma,
// counted from the front and from the back. Both, because "after the first
// comma" and "after the last comma" are different intents that agree on a value
// holding one comma, and only more examples can tell them apart.
func boundary(a []rune, at int, side string) []string {
	c := regexp.QuoteMeta(string(a[at]))

	k := 0
	for _, r := range a[:at+1] {
		if r == a[at] {
			k++
		}
	}
	total := k
	for _, r := range a[at+1:] {
		if r == a[at] {
			total++
		}
	}

	return []string{
		side + "(/" + c + "/, " + strconv.Itoa(k) + ")",
		side + "(/" + c + "/, " + strconv.Itoa(k-total-1) + ")",
	}
}

// cross enumerates one choice per part, stopping at the same bound every other
// generator here respects.
func cross(sets [][]string) [][]string {
	out := [][]string{{}}
	for _, set := range sets {
		next := make([][]string, 0, len(out)*len(set))
		for _, have := range out {
			for _, s := range set {
				if len(next) >= maxPerExample {
					return next
				}
				next = append(next, append(append([]string{}, have...), s))
			}
		}
		out = next
	}
	return out
}
