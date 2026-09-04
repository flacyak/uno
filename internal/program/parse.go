package program

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// parser is a scanner over the text form. It is hand-written because the
// grammar is five step names deep and a generated parser would be a build step
// and a dependency for something smaller than the file describing it.
type parser struct {
	s []rune
	i int
}

func (p *parser) space() {
	for p.i < len(p.s) && unicode.IsSpace(p.s[p.i]) {
		p.i++
	}
}

func (p *parser) accept(r rune) bool {
	p.space()
	if p.i < len(p.s) && p.s[p.i] == r {
		p.i++
		return true
	}
	return false
}

func (p *parser) expect(r rune) error {
	if p.accept(r) {
		return nil
	}
	return fmt.Errorf("expected %q at character %d, %s", string(r), p.i+1, p.here())
}

// here names what was found instead, so an error points at the text rather than
// only at an offset into it.
func (p *parser) here() string {
	if p.i >= len(p.s) {
		return "and the program ends there"
	}
	return fmt.Sprintf("found %q", string(p.s[p.i:min(p.i+8, len(p.s))]))
}

func (p *parser) ident() string {
	p.space()
	start := p.i
	for p.i < len(p.s) && unicode.IsLetter(p.s[p.i]) {
		p.i++
	}
	return string(p.s[start:p.i])
}

func (p *parser) step() (Step, error) {
	name := p.ident()
	if name == "" {
		return nil, fmt.Errorf("expected a step name at character %d, %s", p.i+1, p.here())
	}
	if err := p.expect('('); err != nil {
		return nil, err
	}

	var (
		st  Step
		err error
	)
	switch name {
	case "replace":
		st, err = p.replaceArgs()
	case "slice":
		st, err = p.sliceArgs()
	case "concat":
		st, err = p.concatArgs()
	case "trim":
		st = trimStep{}
	case "upper":
		st = caseStep{up: true}
	case "lower":
		st = caseStep{}
	default:
		err = fmt.Errorf("unknown step %q at character %d", name, p.i-len(name))
	}
	if err != nil {
		return nil, err
	}
	return st, p.expect(')')
}

func (p *parser) replaceArgs() (Step, error) {
	re, err := p.regexArg()
	if err != nil {
		return nil, err
	}
	if err := p.expect(','); err != nil {
		return nil, err
	}
	lit, err := p.stringArg()
	if err != nil {
		return nil, err
	}
	return Replace(re, lit)
}

func (p *parser) sliceArgs() (Step, error) {
	from, err := p.pos()
	if err != nil {
		return nil, err
	}
	if err := p.expect(','); err != nil {
		return nil, err
	}
	to, err := p.pos()
	if err != nil {
		return nil, err
	}
	return sliceStep{from: from, to: to}, nil
}

// concatArgs reads the parts. A single part is refused: concat of one thing is
// that thing, and two spellings of one program would both have to round-trip.
func (p *parser) concatArgs() (Step, error) {
	var parts []Step
	for {
		p.space()
		switch {
		case p.i < len(p.s) && p.s[p.i] == '"':
			lit, err := p.stringArg()
			if err != nil {
				return nil, err
			}
			parts = append(parts, constStep{lit: lit})
		default:
			if name := p.ident(); name != "slice" {
				return nil, fmt.Errorf("expected a \"string\" or slice( at character %d, %s",
					p.i+1, p.here())
			}
			if err := p.expect('('); err != nil {
				return nil, err
			}
			st, err := p.sliceArgs()
			if err != nil {
				return nil, err
			}
			if err := p.expect(')'); err != nil {
				return nil, err
			}
			parts = append(parts, st)
		}
		if !p.accept(',') {
			break
		}
	}
	if len(parts) < 2 {
		return nil, fmt.Errorf("concat of %d part: a concat needs at least two", len(parts))
	}
	if len(parts) > MaxParts {
		return nil, fmt.Errorf("concat of %d parts, and the limit is %d", len(parts), MaxParts)
	}
	return concatStep{parts: parts}, nil
}

func (p *parser) pos() (pos, error) {
	p.space()
	if p.i < len(p.s) && (p.s[p.i] == '-' || unicode.IsDigit(p.s[p.i])) {
		k, err := p.intArg()
		return idxPos{k: k}, err
	}

	name := p.ident()
	if name == "len" {
		return lenPos{}, nil
	}
	if name != "start" && name != "end" {
		return nil, fmt.Errorf("expected a character index, len, start( or end( at character %d, %s",
			p.i+1, p.here())
	}
	if err := p.expect('('); err != nil {
		return nil, err
	}
	re, err := p.regexArg()
	if err != nil {
		return nil, err
	}
	if err := p.expect(','); err != nil {
		return nil, err
	}
	k, err := p.intArg()
	if err != nil {
		return nil, err
	}
	if k == 0 {
		return nil, fmt.Errorf("match number 0 at character %d: matches are counted from 1", p.i)
	}
	c, err := regexp.Compile(re)
	if err != nil {
		return nil, fmt.Errorf("pattern /%s/: %w", re, err)
	}
	return matchPos{re: c, src: re, k: k, atEnd: name == "end"}, p.expect(')')
}

// regexArg reads /.../ and unescapes only the delimiter. Everything else is
// handed to regexp untouched, so \d in a program means what it means everywhere
// else rather than what this parser decided it should.
func (p *parser) regexArg() (string, error) {
	p.space()
	if p.i >= len(p.s) || p.s[p.i] != '/' {
		return "", fmt.Errorf("expected a /pattern/ at character %d, %s", p.i+1, p.here())
	}
	p.i++

	var b strings.Builder
	for p.i < len(p.s) {
		switch c := p.s[p.i]; {
		case c == '\\' && p.i+1 < len(p.s):
			if p.s[p.i+1] == '/' {
				b.WriteRune('/')
			} else {
				b.WriteRune('\\')
				b.WriteRune(p.s[p.i+1])
			}
			p.i += 2
		case c == '/':
			p.i++
			return b.String(), nil
		default:
			b.WriteRune(c)
			p.i++
		}
	}
	return "", fmt.Errorf("a /pattern/ was opened and never closed")
}

func (p *parser) stringArg() (string, error) {
	p.space()
	if p.i >= len(p.s) || p.s[p.i] != '"' {
		return "", fmt.Errorf("expected a \"string\" at character %d, %s", p.i+1, p.here())
	}

	// strconv.Unquote decides where the string ends, so the escape rules here
	// are Go's rather than a second set invented for this file.
	for j := p.i + 1; j < len(p.s); j++ {
		if p.s[j] == '\\' {
			j++
			continue
		}
		if p.s[j] == '"' {
			v, err := strconv.Unquote(string(p.s[p.i : j+1]))
			if err != nil {
				return "", fmt.Errorf("string at character %d: %w", p.i+1, err)
			}
			p.i = j + 1
			return v, nil
		}
	}
	return "", fmt.Errorf("a \"string\" was opened and never closed")
}

func (p *parser) intArg() (int, error) {
	p.space()
	start := p.i
	if p.i < len(p.s) && p.s[p.i] == '-' {
		p.i++
	}
	for p.i < len(p.s) && unicode.IsDigit(p.s[p.i]) {
		p.i++
	}
	n, err := strconv.Atoi(string(p.s[start:p.i]))
	if err != nil {
		return 0, fmt.Errorf("expected a number at character %d, %s", start+1, p.here())
	}
	return n, nil
}

// quoteRegex renders a pattern back between slashes, escaping the delimiter so
// a pattern containing one still round-trips.
func quoteRegex(src string) string {
	return "/" + strings.ReplaceAll(src, "/", `\/`) + "/"
}

// charNames is the vocabulary Describe speaks. It covers the punctuation that
// turns a number column into a text one, which is the whole of what the
// recogniser proposes today; anything outside it falls back to the notation.
var charNames = map[rune]string{
	',':  "commas",
	'.':  "full stops",
	'$':  "dollar signs",
	'£':  "pound signs",
	'€':  "euro signs",
	'%':  "percent signs",
	'_':  "underscores",
	'\'': "apostrophes",
	' ':  "spaces",
	'*':  "asterisks",
	'#':  "hashes",
	'/':  "slashes",
	'-':  "dashes",
	'+':  "plus signs",
	'(':  "brackets",
	')':  "brackets",
	'"':  "quotes",
	'“':  "quotes",
	'”':  "quotes",
}

// literalOf returns the text a pattern matches, when the pattern is that text and
// nothing else. It inverts the QuoteMeta the deletion lattice applies, and refuses
// anything it cannot invert exactly.
func literalOf(src string) (string, bool) {
	var b strings.Builder
	for i := 0; i < len(src); i++ {
		if c := src[i]; c == '\\' {
			if i++; i >= len(src) || !isMeta(src[i]) {
				return "", false
			}
			b.WriteByte(src[i])
		} else if isMeta(c) {
			return "", false
		} else {
			b.WriteByte(c)
		}
	}
	return b.String(), b.Len() > 0
}

func isMeta(c byte) bool { return strings.IndexByte(`\.+*?()|[]{}^$`, c) >= 0 }

// nameChars turns a pattern back into English when it is a plain literal or a
// plain class of characters this vocabulary knows. Anything with an anchor, a
// quantifier or a character it cannot name is refused, so Describe falls back
// rather than describing a program approximately.
func nameChars(src string) (string, bool) {
	// The deletion lattice anchors its class rungs. Strip the anchor and say
	// where it pointed, rather than refusing a program the recogniser offers.
	where := ""
	switch {
	case strings.HasPrefix(src, "^") && strings.HasSuffix(src, "+"):
		src, where = strings.TrimSuffix(src[1:], "+"), " from the start"
	case strings.HasSuffix(src, "+$"):
		src, where = strings.TrimSuffix(src, "+$"), " from the end"
	}

	body := src
	if strings.HasPrefix(src, "[") && strings.HasSuffix(src, "]") {
		body = src[1 : len(src)-1]
	}

	var names []string
	seen := map[string]bool{}
	rs := []rune(body)
	for i := 0; i < len(rs); i++ {
		r := rs[i]
		switch {
		case r == '\\':
			// quoteClass escapes these four inside a class, and they are still
			// one character to a reader. Any other escape — \d, \s — is a
			// character set rather than a character, and naming it is the
			// regexp package's job.
			if i++; i >= len(rs) || !strings.ContainsRune(`]\^-`, rs[i]) {
				return "", false
			}
			r = rs[i]
		case r == '^' && i == 0:
			return "", false // a negated class means the opposite of what we would say
		}
		n, ok := charNames[r]
		if !ok {
			return "", false
		}
		if !seen[n] {
			seen[n] = true
			names = append(names, n)
		}
	}
	if len(names) == 0 {
		return "", false
	}
	if len(names) == 1 {
		return names[0] + where, true
	}
	return strings.Join(names[:len(names)-1], ", ") + " and " + names[len(names)-1] + where, true
}
