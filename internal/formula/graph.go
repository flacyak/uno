package formula

import (
	"fmt"
	"sort"
	"strings"
)

// Graph is the dependency graph of the bound columns.
//
// Columns depend on columns, so the graph is tiny: one node per column, not one
// per cell. A general spreadsheet lets any cell name any cell, which on the
// sample sheet is 28,872 nodes and a partial re-evaluation over them for every
// edit — a real engine, and the reason recalculation is a famously hard
// problem. Whole-column scope collapses that to six nodes here and twenty in a
// wide export, where a topological sort is a few lines and cycle detection is
// the same walk. The constraint is what buys a correct recalculation model
// without a cell-level engine.
//
// Nodes are named by column name rather than by an index or an ID because sheet
// owns header-to-index resolution and formula stays sheet-free. It is also the
// name a person reads in a refused binding.
//
// The zero Graph is usable and holds nothing bound, so a workspace with no
// formulas is a graph rather than a special case.
type Graph struct {
	// deps holds edges, not formulas. What a column resolves to is sheet
	// state — it is saved in the .uno and reloaded from it — and a second
	// home for it here would be a second thing to keep in step.
	deps map[string][]string
}

// Bind records that col is computed from f, and refuses a cycle.
//
// Refusing here is the whole point: a cycle found during a recalculation is
// found with half a column already written, and the only thing left to say
// about it is that something went wrong somewhere. Found at bind time it is one
// person, one expression, and a path that names every step of the loop.
func (g *Graph) Bind(col string, f Formula) error {
	deps := f.Refs()
	if path := g.wouldCycle(col, deps); path != nil {
		return fmt.Errorf("%s would depend on itself: %s", col, strings.Join(path, " → "))
	}
	if g.deps == nil {
		g.deps = map[string][]string{}
	}
	g.deps[col] = deps
	return nil
}

// DownstreamOf returns the columns that have to be recalculated after col
// changes, in an order where nothing is computed before what it reads.
//
// It is the columns downstream of the change and not every bound column,
// because a recalculation that touched all of them would do work proportional
// to the sheet rather than to the edit. col itself is not in the list: it is
// what changed, not what follows from the change.
func (g *Graph) DownstreamOf(col string) []string {
	// Dependents, transitively. Reversing the edges once per call is cheap at
	// twenty nodes and leaves one representation to keep correct instead of
	// two.
	rev := map[string][]string{}
	for c, ds := range g.deps {
		for _, d := range ds {
			rev[d] = append(rev[d], c)
		}
	}

	down := map[string]bool{}
	var collect func(string)
	collect = func(at string) {
		for _, c := range rev[at] {
			if !down[c] {
				down[c] = true
				collect(c)
			}
		}
	}
	collect(col)

	// Post-order over the forward edges: a column is emitted after every
	// column it reads that is also downstream of the change. This terminates
	// without a visited-in-progress guard because Bind refuses cycles, which
	// is the second thing that check buys.
	var out []string
	done := map[string]bool{}
	var emit func(string)
	emit = func(c string) {
		if done[c] {
			return
		}
		done[c] = true
		for _, d := range g.deps[c] {
			if down[d] {
				emit(d)
			}
		}
		out = append(out, c)
	}
	for _, c := range sorted(down) {
		emit(c)
	}
	return out
}

// wouldCycle walks from each proposed dependency looking for col, and returns
// the path it got there by. The path is the answer, not the boolean: "margin
// would depend on itself" is a puzzle, and "margin → price → margin" is the
// two edits that fix it.
func (g *Graph) wouldCycle(col string, deps []string) []string {
	var path []string
	seen := map[string]bool{}

	var walk func(string) bool
	walk = func(at string) bool {
		path = append(path, at)
		if at == col {
			return true
		}
		if !seen[at] {
			seen[at] = true
			for _, d := range g.deps[at] {
				if walk(d) {
					return true
				}
			}
		}
		path = path[:len(path)-1]
		return false
	}

	for _, d := range deps {
		if walk(d) {
			return append([]string{col}, path...)
		}
	}
	return nil
}

// sorted fixes the order the walks start in, so a graph that is bound the same
// way twice recalculates in the same order twice. Map iteration would leave
// that to chance, and an order nobody can reproduce is an order nobody can
// debug.
func sorted(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for c := range set {
		out = append(out, c)
	}
	sort.Strings(out)
	return out
}
