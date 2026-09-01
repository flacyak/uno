package ingest

import (
	"bufio"
	"strings"
)

// candidates are the separators worth guessing between. Anything else is rare
// enough that being wrong about it is better handled by the person telling us.
var candidates = []rune{',', '\t', ';', '|'}

// sniffLines bounds the peek. A delimiter that is not consistent across the
// first few lines is not the delimiter.
const sniffLines = 5

// sniffDelimiter guesses from the bytes rather than asking. A dialog asking for
// a delimiter is a question the file already answers; the guess is shown in the
// status bar so it can be seen, and the open never blocks on it.
//
// It peeks and does not consume: the caller reads the same reader afterwards.
func sniffDelimiter(r *bufio.Reader) rune {
	head, _ := r.Peek(64 << 10) // short reads are fine; a small file is all of it
	lines := headLines(string(head))
	if len(lines) == 0 {
		return ','
	}

	best, bestFields := ',', 1
	for _, c := range candidates {
		fields, consistent := fieldCount(lines, c)
		// Consistency is what separates a real delimiter from a character that
		// happens to appear: a ';' inside prose shows up on some lines only.
		if consistent && fields > bestFields {
			best, bestFields = c, fields
		}
	}
	return best
}

// headLines splits the peeked bytes into whole lines. The last line is dropped
// unless it was terminated, because a line cut in half by the peek limit has a
// field count that means nothing and would fail every consistency check.
func headLines(s string) []string {
	if i := strings.LastIndexByte(s, '\n'); i >= 0 {
		s = s[:i+1]
	}

	var out []string
	for _, l := range strings.Split(s, "\n") {
		if len(out) == sniffLines {
			break
		}
		if l = strings.TrimSuffix(l, "\r"); l != "" {
			out = append(out, l)
		}
	}
	return out
}

// fieldCount reports how many fields the separator yields per line, and whether
// every line agreed. Quoted sections are skipped so a comma inside "Okafor, Ada"
// is not counted as a separator.
func fieldCount(lines []string, sep rune) (int, bool) {
	want := -1
	for _, l := range lines {
		n := 1
		inQuote := false
		for _, r := range l {
			switch {
			case r == '"':
				inQuote = !inQuote
			case r == sep && !inQuote:
				n++
			}
		}
		if want == -1 {
			want = n
		} else if n != want {
			return 0, false
		}
	}
	return want, want > 1
}
