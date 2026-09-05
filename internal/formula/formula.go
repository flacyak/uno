// Package formula is uno's arithmetic: the expression a column formula binds,
// and the text a .unof carries.
//
// It is its own package for the reason program is one. Its text form is public
// API: a .uno stores the expression beside the library reference so the file
// stays self-contained for someone who does not have the sender's library, and
// an expression this build cannot read has to fail before a single cell moves.
// Parsing is therefore interpretation of a stored text rather than a second
// guess at it.
//
// Nothing here knows what a sheet is. A row reaches an expression through Row,
// which is the same boundary program draws, and it is what lets sheet import
// formula without formula importing sheet back.
//
// It is not program. A program is a string rewriting pipeline with no numbers,
// no operators and no infix; its slash is a regex delimiter. Nothing in it
// composes into an expression tree, so nothing in it is reused here.
package formula

import "sort"

// Formula is one arithmetic expression, bound to a whole column rather than to
// a cell. Whole-column scope is the constraint the whole design rests on: it is
// what keeps the dependency graph one node per column instead of one per cell.
//
// The zero Formula is empty and evaluates to an error rather than a panic. A
// binding arrives out of a state.json written by some other build, and a
// missing expression must fail as a value on the path that reads it.
type Formula struct{ root node }

// String renders the tree back into the text Parse accepts, so an expression
// that made a round trip through a file is the same expression.
//
// It renders from the tree rather than handing back the source it was parsed
// from. Returning the source would make the round trip true by construction and
// tell nobody whether the tree agrees with it, which is the one thing the text
// form is for. The price is that spacing is normalised — one space either side
// of a binary operator — so String is a normal form and not a transcription of
// what was typed. What a person wrote that carries meaning survives: their own
// parentheses are a node, so (a + b) * c never comes back as a + b * c.
func (f Formula) String() string {
	if f.root == nil {
		return ""
	}
	return f.root.String()
}

// Refs names every column the expression reads, sorted and deduplicated.
//
// This is the walk cycle detection is built on, so it has to be the whole truth
// about what a formula depends on: a reference this misses is an edge the graph
// does not have, and an edge the graph does not have is a cycle it accepts.
// Sorted because the order reaches a person, in the .unof's refs and in the
// path a refused binding names, and an order that changes between runs is one
// nobody can diff.
func (f Formula) Refs() []string {
	seen := map[string]bool{}
	if f.root != nil {
		f.root.refs(seen)
	}
	out := make([]string, 0, len(seen))
	for c := range seen {
		out = append(out, c)
	}
	sort.Strings(out)
	return out
}

// node is one term of an expression.
//
// refs is unexported, which seals the interface the way run seals program.Step:
// a tree this package did not build is a tree its evaluator has never seen, so
// Eval's walk can be exhaustive over five types rather than defensive about an
// open set of them.
type node interface {
	// String renders this term back into the text form Parse accepts.
	String() string

	// refs adds the columns this term reads. It takes the set rather than
	// returning a slice because the walk is over a tree and the answer is a
	// union, and merging slices at every join would allocate for nothing.
	refs(map[string]bool)
}

// numLit keeps the text it was written as, not only the value it parsed to.
// 40.00 and 40 are one number and two different things to read, and an editor
// that rewrites a literal while someone is still typing it is one they stop
// trusting. The float is carried alongside so evaluation does not re-parse it
// once per row.
type numLit struct {
	text string
	v    float64
}

func (n numLit) String() string     { return n.text }
func (numLit) refs(map[string]bool) {}

// colRef names a column by its header, not by an index or an ID. sheet owns
// header-to-index resolution, and a formula that stored an index would be a
// formula that silently meant a different column after an insert — and one
// nobody could read in a .unof.
//
// A header that is not a valid identifier cannot be referenced. That is a
// stated limit rather than a reason to invent a quoting syntax: a second
// spelling of every name would have to round-trip, and the answer to a column
// called "Q3 (net)" is to rename it.
type colRef struct{ name string }

func (c colRef) String() string         { return c.name }
func (c colRef) refs(s map[string]bool) { s[c.name] = true }

// binary is one operator and its two operands, already shaped by precedence, so
// the tree says what the arithmetic means and rendering never has to guess
// where a bracket is needed. Where a bracket was written, group holds it.
type binary struct {
	op          rune
	left, right node
}

func (b binary) String() string {
	return b.left.String() + " " + string(b.op) + " " + b.right.String()
}

func (b binary) refs(s map[string]bool) {
	b.left.refs(s)
	b.right.refs(s)
}

// unary is a leading minus. There is no unary plus: +x means x, so accepting it
// would give one expression two spellings and both would have to round-trip.
type unary struct{ operand node }

func (u unary) String() string         { return "-" + u.operand.String() }
func (u unary) refs(s map[string]bool) { u.operand.refs(s) }

// group is a real node rather than a hint dropped after parsing, so a person's
// own parentheses come back out of the file the way they went in. They are how
// someone shows their working — (price - cost) / price is read as a fraction —
// and a build that quietly removed the redundant ones would be editing an
// expression it was only asked to store.
type group struct{ inner node }

func (g group) String() string         { return "(" + g.inner.String() + ")" }
func (g group) refs(s map[string]bool) { g.inner.refs(s) }
