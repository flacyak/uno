package sheet

import (
	"strconv"
	"strings"
	"time"
)

// Kind is what a column looks like. It is inferred at load and never stored in
// the file, so changing the inference rules can never invalidate a saved sheet.
type Kind int

const (
	KindText Kind = iota
	KindNum
	KindDate
)

func (k Kind) String() string {
	switch k {
	case KindNum:
		return "num"
	case KindDate:
		return "date"
	default:
		return "text"
	}
}

// sampleRows bounds the work done at open. Measuring all 4,812 rows of six
// columns to name their kinds costs 28,872 parses before the first frame; the
// top of the file is enough to catch the shape of a column.
const sampleRows = 200

// inferKind reads down one column of the sample and names it.
//
// The flagged case is the one worth being precise about. A column is flagged
// when every value would be a number but for a formatting convention the parser
// does not accept: a separator, a currency mark, a percent sign. That is a
// stricter test than "mostly numeric", and deliberately so: a column with the odd
// "N/A" in it is genuinely mixed, whereas a column where 1,204 sits beside 987
// is numeric data wearing a costume, and it is the second that M2 offers to fix.
func inferKind(rows [][]string, col int) (kind Kind, flagged bool) {
	var seen, nums, formatted, dates int

	for i := 0; i < len(rows) && i < sampleRows; i++ {
		if col >= len(rows[i]) {
			continue // ragged row, nothing to learn from it
		}
		v := strings.TrimSpace(rows[i][col])
		if v == "" {
			continue // a blank is not evidence either way
		}
		seen++
		switch {
		case isDate(v):
			dates++
		case isNumber(v):
			nums++
		case isNumber(undress(v)):
			formatted++
		}
	}

	switch {
	case seen == 0:
		return KindText, false
	case dates == seen:
		return KindDate, false
	case nums == seen:
		return KindNum, false
	case nums+formatted == seen:
		return KindText, true
	default:
		return KindText, false
	}
}

// decoration is what a number wears when it was formatted for a reader rather
// than for a parser. The set is fixed and short, and leaves out the full stop:
// the badge claims a column is numeric data in a costume, and a wider set would
// let it claim that about text.
const decoration = ",$£€%' "

// undress strips that formatting, for the badge to ask whether what is left is a
// number. It changes no value.
func undress(v string) string {
	return strings.Map(func(r rune) rune {
		if strings.ContainsRune(decoration, r) {
			return -1
		}
		return r
	}, v)
}

// isNumber is deliberately stricter than strconv.ParseFloat alone. ParseFloat
// accepts "inf", "NaN" and hex floats, none of which a spreadsheet column
// means, so the value must first look like a decimal number.
func isNumber(v string) bool {
	if strings.ContainsFunc(v, func(r rune) bool {
		return !strings.ContainsRune("0123456789+-.eE", r)
	}) {
		return false
	}
	_, err := strconv.ParseFloat(v, 64)
	return err == nil
}

var dateLayouts = []string{"2006-01-02", time.RFC3339}

func isDate(v string) bool {
	for _, l := range dateLayouts {
		if _, err := time.Parse(l, v); err == nil {
			return true
		}
	}
	return false
}
