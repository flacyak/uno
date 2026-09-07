package formula

import (
	"fmt"
	"strconv"
	"unicode"
)

// Parse reads the text form.
//
// Everything an expression can be wrong about is decided here rather than at
// evaluation: an unclosed bracket, a name that is not a name, an operator with
// nothing to its right. A binding that survives Parse fails per row or not at
// all, which is what lets the editor preview row one and mean it.
func Parse(src string) (Formula, error) {
	p := &parser{s: []rune(src)}

	n, err := p.expr(0)
	if err != nil {
		return Formula{}, fmt.Errorf("formula %q: %w", src, err)
	}
	p.space()
	if p.i < len(p.s) {
		return Formula{}, fmt.Errorf("formula %q: unexpected %q at character %d",
			src, string(p.s[p.i]), p.i+1)
	}
	return Formula{root: n}, nil
}

// parser is a scanner over the text form. It is hand-written for the reason
// program's is: the grammar is four operators and three kinds of term, and a
// generated parser would be a build step and a dependency for something larger
// than the file it replaced.
//
// Lexing happens inside the parser rather than ahead of it. There are no
// keywords and no lookahead past one rune, so a token slice would be a second
// representation of the same string, and the character offsets an error points
// at would have to be carried through it.
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
		return "and the formula ends there"
	}
	return fmt.Sprintf("found %q", string(p.s[p.i:min(p.i+8, len(p.s))]))
}

// precedence orders the four operators and nothing else. Reporting 0 for
// anything that is not one is how the expression loop knows it has reached the
// end of what it is allowed to eat.
func precedence(r rune) int {
	switch r {
	case '+', '-':
		return 1
	case '*', '/':
		return 2
	}
	return 0
}

// expr climbs precedence: it reads a term, then keeps taking operators at least
// as binding as min and recursing one level tighter for their right-hand side.
// Recursing at prec+1 is what makes every operator left-associative, so a - b -
// c groups the way arithmetic reads it rather than the way the recursion falls
// out.
func (p *parser) expr(min int) (node, error) {
	left, err := p.term()
	if err != nil {
		return nil, err
	}
	for {
		p.space()
		if p.i >= len(p.s) {
			return left, nil
		}
		op := p.s[p.i]
		prec := precedence(op)
		if prec == 0 || prec < min {
			return left, nil
		}
		p.i++
		right, err := p.expr(prec + 1)
		if err != nil {
			return nil, err
		}
		left = binary{op: op, left: left, right: right}
	}
}

// term reads one operand, including any leading minuses. A minus binds tighter
// than every binary operator, so -a * b is (-a) * b — which is the same number
// either way for these four operators, and the reading a person expects.
func (p *parser) term() (node, error) {
	if p.accept('-') {
		operand, err := p.term()
		if err != nil {
			return nil, err
		}
		return unary{operand: operand}, nil
	}

	p.space()
	if p.i >= len(p.s) {
		return nil, fmt.Errorf("expected a number, a column name or ( at character %d, %s",
			p.i+1, p.here())
	}

	switch c := p.s[p.i]; {
	case c == '(':
		p.i++
		inner, err := p.expr(0)
		if err != nil {
			return nil, err
		}
		if err := p.expect(')'); err != nil {
			return nil, err
		}
		return group{inner: inner}, nil
	case unicode.IsDigit(c):
		return p.number()
	case isIdentStart(c):
		return colRef{name: p.ident()}, nil
	}
	return nil, fmt.Errorf("expected a number, a column name or ( at character %d, %s",
		p.i+1, p.here())
}

// number reads a decimal literal, and only a decimal one. It refuses the
// exponent, hex and infinity forms strconv would otherwise accept, for the
// reason num.IsNumber does: none of them is a thing a person writes into a
// spreadsheet, and each is a thing a typo can be read as.
func (p *parser) number() (node, error) {
	start := p.i
	for p.i < len(p.s) && unicode.IsDigit(p.s[p.i]) {
		p.i++
	}
	if p.i < len(p.s) && p.s[p.i] == '.' {
		p.i++
		if p.i >= len(p.s) || !unicode.IsDigit(p.s[p.i]) {
			return nil, fmt.Errorf("expected a digit after the full stop at character %d, %s",
				p.i+1, p.here())
		}
		for p.i < len(p.s) && unicode.IsDigit(p.s[p.i]) {
			p.i++
		}
	}
	text := string(p.s[start:p.i])
	v, err := strconv.ParseFloat(text, 64)
	if err != nil {
		return nil, fmt.Errorf("number %q at character %d: %w", text, start+1, err)
	}
	return numLit{text: text, v: v}, nil
}

// ident reads a column name. Letters, digits and underscores, never starting
// with a digit, because a name that starts with a digit could not be told from
// the number beside it. Letter is unicode's letter rather than an ASCII range:
// a header is as likely to be région as it is to be region, and a build that
// could not reference it would be refusing the data it was given.
func (p *parser) ident() string {
	start := p.i
	for p.i < len(p.s) && isIdentRune(p.s[p.i]) {
		p.i++
	}
	return string(p.s[start:p.i])
}

func isIdentStart(r rune) bool { return unicode.IsLetter(r) || r == '_' }

func isIdentRune(r rune) bool { return isIdentStart(r) || unicode.IsDigit(r) }
