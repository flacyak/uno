// Package num reads the number a spreadsheet cell holds, which is not always
// the number strconv reads.
//
// It is its own package because two callers need one answer and neither can own
// it. sheet asks whether a column is numeric data wearing a costume, and
// formula asks what a cell is worth before multiplying it; sheet imports
// formula, so formula can never import sheet back, and the coercion cannot live
// in either. A second copy of it would be the copy that quietly stops matching
// the first, which is the argument that produced internal/safefile.
//
// Nothing here knows what a sheet is. A value arrives as the string it was
// stored as, per I-1, and leaves as a float64 or as nothing.
package num

import (
	"strconv"
	"strings"
)

// Decoration is what a number wears when it was formatted for a reader rather
// than for a parser. The set is fixed and short, and leaves out the full stop:
// the badge it feeds claims a column is numeric data in a costume, and a wider
// set would let it claim that about text.
const Decoration = ",$£€%' "

// Undress strips that formatting, so a caller can ask whether what is left is a
// number. It changes no stored value: the raw bytes are authoritative (I-4) and
// this reads a copy of them.
func Undress(v string) string {
	return strings.Map(func(r rune) rune {
		if strings.ContainsRune(Decoration, r) {
			return -1
		}
		return r
	}, v)
}

// IsNumber is deliberately stricter than strconv.ParseFloat alone. ParseFloat
// accepts "inf", "NaN" and hex floats, none of which a spreadsheet column
// means, so the value must first look like a decimal number.
func IsNumber(v string) bool {
	if strings.ContainsFunc(v, func(r rune) bool {
		return !strings.ContainsRune("0123456789+-.eE", r)
	}) {
		return false
	}
	_, err := strconv.ParseFloat(v, 64)
	return err == nil
}

// Parse reads a cell as arithmetic reads it: undressed first, so a column an
// evaluator was pointed at computes on the value a person sees rather than
// refusing 1,204 for wearing a comma.
//
// It reports false rather than returning an error because the caller that has
// something to say about the failure is the one that knows which column and
// which row the value came from, and this package knows neither.
func Parse(v string) (float64, bool) {
	u := Undress(v)
	if !IsNumber(u) {
		return 0, false
	}
	f, err := strconv.ParseFloat(u, 64)
	return f, err == nil
}
