package sheet

import (
	"strings"
	"time"

	"github.com/flacyak/uno/internal/num"
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
		case num.IsNumber(v):
			nums++
		case num.IsNumber(num.Undress(v)):
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

var dateLayouts = []string{"2006-01-02", time.RFC3339}

func isDate(v string) bool {
	for _, l := range dateLayouts {
		if _, err := time.Parse(l, v); err == nil {
			return true
		}
	}
	return false
}
