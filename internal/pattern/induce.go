package pattern

import (
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"github.com/flacyak/uno/internal/program"
)

// maxDiff bounds the alignment. Two 128-character values cost 16,384 cells to
// align, and a cell longer than that is prose rather than a field with a
// convention in it — there is no transformation to induce from a paragraph.
const maxDiff = 128

// maxPerExample bounds how many programs one example may suggest. The bound
// matters because the candidate sets are intersected: a wide set costs its width
// once per example, and the intersection is what narrows it, not the generator.
const maxPerExample = 256

// induce is the synthesiser. It asks each example what programs could have
// produced it, then keeps only the programs every example agrees on.
//
// This is a version space, intersected: the candidate set for one example is
// every program in the language consistent with it, and the answer is the
// intersection across all of them. The set is enumerated rather than held
// symbolically, which is what keeps this a few hundred lines instead of a few
// thousand — the lattice each witness draws from is deliberately small, so a
// finite list is the whole space rather than a sample of it.
//
// A fourth example can only ever shrink the result. That is the property the
// whole design leans on: watching someone work never makes the guess worse.
func induce(ex []example, witness func(was, now string) []string) []program.Program {
	if len(ex) == 0 {
		return nil
	}

	keep := dedup(witness(ex[0].was, ex[0].now))
	for _, e := range ex[1:] {
		keep = intersect(keep, dedup(witness(e.was, e.now)))
		if len(keep) == 0 {
			return nil
		}
	}

	slices.Sort(keep)
	return parseAll(keep)
}

func intersect(a, b []string) []string {
	in := make(map[string]bool, len(b))
	for _, s := range b {
		in[s] = true
	}
	out := a[:0:0]
	for _, s := range a {
		if in[s] {
			out = append(out, s)
		}
	}
	return out
}

// parseAll turns the generated text into programs. A candidate that does not
// parse is a bug in a witness function, and it is dropped rather than raised:
// the tests are where that is caught, and a person editing a spreadsheet should
// not be shown a dialog about it.
func parseAll(srcs []string) []program.Program {
	out := make([]program.Program, 0, len(srcs))
	for _, s := range srcs {
		if p, err := program.Parse(s); err == nil {
			out = append(out, p)
		}
	}
	return out
}

func dedup(in []string) []string {
	seen := make(map[string]bool, len(in))
	out := in[:0:0]
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	if len(out) > maxPerExample {
		sort.Strings(out)
		out = out[:maxPerExample]
	}
	return out
}

// run is a stretch of characters the alignment says was removed or added.
type run struct {
	text string
	at   int // rune offset into the value it belongs to
}

// rewrites induces the programs that change characters where they stand: the
// deletions, the substitutions and the case changes.
func rewrites(was, now string) []string {
	if was == now {
		return nil
	}

	var out []string
	if strings.EqualFold(was, now) {
		if now == strings.ToUpper(was) {
			out = append(out, "upper()")
		}
		if now == strings.ToLower(was) {
			out = append(out, "lower()")
		}
	}

	a, b := []rune(was), []rune(now)
	dels, ins, ok := align(a, b)
	if !ok {
		return out
	}

	switch {
	case len(dels) > 0 && len(ins) == 0:
		out = append(out, deletions(a, dels)...)
	case len(dels) == 1 && len(ins) == 1:
		out = append(out, substitutions(dels[0], ins[0])...)
	}
	return out
}

// deletions generalises "these stretches went away".
//
// The lattice is four rungs: the exact text, the class of characters it is made
// of, and each of those anchored to the end the deletions actually sat at. It
// climbs from specific to general so that ranking can prefer the narrowest
// program that still explains every example, which is the guard against reading
// one habit as a licence to rewrite a whole column.
func deletions(a []rune, dels []run) []string {
	var (
		out    []string
		texts  = map[string]bool{}
		chars  []rune
		seen   = map[rune]bool{}
		prefix = true
		suffix = true
		spaces = true
		edges  = true // every run touches an end, not necessarily the same one
	)

	for _, d := range dels {
		texts[d.text] = true
		for _, r := range d.text {
			if !seen[r] {
				seen[r] = true
				chars = append(chars, r)
			}
			if !unicode.IsSpace(r) {
				spaces = false
			}
		}
		head := d.at == 0
		tail := d.at+len([]rune(d.text)) == len(a)
		if !head {
			prefix = false
		}
		if !tail {
			suffix = false
		}
		if !head && !tail {
			edges = false
		}
	}
	if len(chars) == 0 {
		return nil
	}
	slices.Sort(chars)

	if len(texts) == 1 {
		for t := range texts {
			out = append(out, replaceSrc(regexp.QuoteMeta(t), ""))
		}
	}

	class := "[" + quoteClass(chars) + "]"
	out = append(out, replaceSrc(class, ""))
	if suffix {
		out = append(out, replaceSrc(class+"+$", ""))
	}
	if prefix {
		out = append(out, replaceSrc("^"+class+"+", ""))
	}
	// Both ends at once is the ordinary case and neither anchor covers it, so
	// trim asks about the ends rather than about the anchor they share.
	if spaces && edges {
		out = append(out, "trim()")
	}
	return out
}

// substitutions generalises "this stretch became that one".
func substitutions(d, i run) []string {
	out := []string{replaceSrc(regexp.QuoteMeta(d.text), i.text)}

	chars := []rune(d.text)
	slices.Sort(chars)
	chars = slices.Compact(chars)
	out = append(out, replaceSrc("["+quoteClass(chars)+"]+", i.text))

	if strings.TrimSpace(d.text) == "" {
		out = append(out, replaceSrc(`\s+`, i.text))
	}
	return out
}

func replaceSrc(re, lit string) string {
	return "replace(" + "/" + strings.ReplaceAll(re, "/", `\/`) + "/, " + strconv.Quote(lit) + ")"
}

// quoteClass escapes what a character class treats specially. The characters
// this matters for — the separators, the currency marks — are exactly the ones
// the recogniser exists to remove.
func quoteClass(rs []rune) string {
	var b strings.Builder
	for _, r := range rs {
		if strings.ContainsRune(`]\^-`, r) {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

// align is a longest-common-subsequence diff, returning what was removed from a
// and what was added from b, as runs rather than as characters: 1,204,567 has
// two deletions of one comma, not two unrelated character events.
func align(a, b []rune) (dels, ins []run, ok bool) {
	if len(a) > maxDiff || len(b) > maxDiff {
		return nil, nil, false
	}

	// lcs[i][j] is the length of the longest common subsequence of a[i:] and
	// b[j:], which lets the reconstruction below walk forwards.
	lcs := make([][]int, len(a)+1)
	for i := range lcs {
		lcs[i] = make([]int, len(b)+1)
	}
	for i := len(a) - 1; i >= 0; i-- {
		for j := len(b) - 1; j >= 0; j-- {
			if a[i] == b[j] {
				lcs[i][j] = lcs[i+1][j+1] + 1
			} else {
				lcs[i][j] = max(lcs[i+1][j], lcs[i][j+1])
			}
		}
	}

	var d, n strings.Builder
	dAt, nAt := 0, 0
	flush := func() {
		if d.Len() > 0 {
			dels = append(dels, run{text: d.String(), at: dAt})
			d.Reset()
		}
		if n.Len() > 0 {
			ins = append(ins, run{text: n.String(), at: nAt})
			n.Reset()
		}
	}

	for i, j := 0, 0; i < len(a) || j < len(b); {
		switch {
		case i < len(a) && j < len(b) && a[i] == b[j]:
			flush()
			i, j = i+1, j+1
		case j == len(b) || (i < len(a) && lcs[i+1][j] >= lcs[i][j+1]):
			if d.Len() == 0 {
				dAt = i
			}
			d.WriteRune(a[i])
			i++
		default:
			if n.Len() == 0 {
				nAt = j
			}
			n.WriteRune(b[j])
			j++
		}
	}
	flush()
	return dels, ins, true
}
