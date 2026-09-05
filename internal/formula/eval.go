package formula

import (
	"errors"
	"fmt"

	"github.com/flacyak/uno/internal/num"
)

// Row is one row of whatever the caller holds. It is an interface, and a
// deliberately small one, because formula must never learn what a sheet is:
// sheet imports formula to bind a column, so an import the other way would be a
// cycle, and the boundary is the same one program's package doc draws.
//
// Value returns the cell as it is stored — a string, per I-1 — and false when
// there is no such column. Coercion happens here rather than at the caller so
// every binding reads a number the same way.
type Row interface {
	Value(col string) (string, bool)
}

// The three ways one cell can fail. They are sentinels because the caller
// decides what a failure looks like: the editor's preview says it in words
// beside the expression, and a bound column shows it in the cell it happened
// in.
var (
	ErrUnknownColumn = errors.New("no such column")
	ErrNotNumber     = errors.New("not a number")
	ErrDivideByZero  = errors.New("divide by zero")
)

// Eval computes the expression for one row.
//
// It reports a failure rather than swallowing it, which is the opposite of what
// program.Apply does with a value it does not fit. The difference is where the
// two come from: a program is induced from a handful of rows and then run over
// thousands, so meeting a row it was not induced from is ordinary. A formula is
// typed by a person against a column they chose, so a row it cannot read is
// something they got wrong and would want told about — with the column named,
// because "not a number" over 4,812 rows is not a thing anyone can act on.
func (f Formula) Eval(r Row) (float64, error) {
	if f.root == nil {
		return 0, errors.New("the formula is empty")
	}
	return eval(f.root, r)
}

// eval walks the tree as a function rather than as a method on each node, which
// keeps the parser complete without it: parse.go compiles, round-trips and
// refuses bad text with no evaluator in the package at all.
func eval(n node, r Row) (float64, error) {
	switch n := n.(type) {
	case numLit:
		return n.v, nil

	case colRef:
		raw, ok := r.Value(n.name)
		if !ok {
			return 0, fmt.Errorf("%s: %w", n.name, ErrUnknownColumn)
		}
		v, ok := num.Parse(raw)
		if !ok {
			return 0, fmt.Errorf("%s = %q: %w", n.name, raw, ErrNotNumber)
		}
		return v, nil

	case group:
		return eval(n.inner, r)

	case unary:
		v, err := eval(n.operand, r)
		if err != nil {
			return 0, err
		}
		return -v, nil

	case binary:
		left, err := eval(n.left, r)
		if err != nil {
			return 0, err
		}
		right, err := eval(n.right, r)
		if err != nil {
			return 0, err
		}
		switch n.op {
		case '+':
			return left + right, nil
		case '-':
			return left - right, nil
		case '*':
			return left * right, nil
		case '/':
			// Refused rather than left to produce ±Inf or NaN. A column of
			// infinities is a wrong answer that displays as one, and the
			// divisor is named because on a bound column the person needs to
			// know which cell was empty.
			if right == 0 {
				return 0, fmt.Errorf("%s: %w", n.right, ErrDivideByZero)
			}
			return left / right, nil
		}
	}

	// Unreachable: node is sealed, so the switch above is the whole set. An
	// error rather than a panic because this runs once per cell, and a term
	// nobody taught the evaluator about is still not worth taking the window
	// down for.
	return 0, fmt.Errorf("unknown term %T", n)
}
