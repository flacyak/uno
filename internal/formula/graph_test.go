package formula

import (
	"reflect"
	"testing"
)

func mustParse(t *testing.T, src string) Formula {
	t.Helper()
	f, err := Parse(src)
	if err != nil {
		t.Fatalf("Parse(%q): %v", src, err)
	}
	return f
}

// bind is the ordinary case, and a failure in it is a broken fixture rather
// than the thing under test.
func mustBind(t *testing.T, g *Graph, col, src string) {
	t.Helper()
	if err := g.Bind(col, mustParse(t, src)); err != nil {
		t.Fatalf("Bind(%q, %q): %v", col, src, err)
	}
}

// A cycle has to be refused at bind time. Discovered during a recalculation it
// is found with half a column already written; discovered here it is one
// person, one expression, and a path naming every step of the loop — which is
// why the message is checked rather than only the failure.
func TestBindRefusesACycleAndNamesThePath(t *testing.T) {
	for _, c := range []struct {
		name  string
		prior [][2]string // column, expression
		col   string
		src   string
		want  string
	}{
		{
			name: "a column that reads itself",
			col:  "margin", src: "margin * 2",
			want: "margin would depend on itself: margin → margin",
		},
		{
			name:  "two columns that read each other",
			prior: [][2]string{{"price", "margin + 1"}},
			col:   "margin", src: "price * 2",
			want: "margin would depend on itself: margin → price → margin",
		},
		{
			name:  "a loop of three",
			prior: [][2]string{{"a", "b * 2"}, {"b", "c * 2"}},
			col:   "c", src: "a * 2",
			want: "c would depend on itself: c → a → b → c",
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			var g Graph // the zero Graph holds nothing bound, and is usable
			for _, p := range c.prior {
				mustBind(t, &g, p[0], p[1])
			}
			err := g.Bind(c.col, mustParse(t, c.src))
			if err == nil {
				t.Fatalf("Bind(%q, %q) = nil, want a refusal", c.col, c.src)
			}
			if err.Error() != c.want {
				t.Errorf("Bind error = %q, want %q", err, c.want)
			}
			if got := g.DownstreamOf(c.col); contains(got, c.col) {
				t.Errorf("the refused binding was recorded anyway: %v", got)
			}
		})
	}
}

// Two columns reading the same input and a third reading both of them is a
// diamond, not a loop. A cycle check that walked breadth of reuse rather than
// depth of dependency would refuse it, and refusing the commonest shape a
// spreadsheet takes would make formulas useless.
func TestADiamondIsNotACycle(t *testing.T) {
	var g Graph
	mustBind(t, &g, "left", "base * 2")
	mustBind(t, &g, "right", "base + 1")
	if err := g.Bind("total", mustParse(t, "left + right")); err != nil {
		t.Fatalf("Bind: %v", err)
	}
}

// Recalculation walks only what follows from the edit, and nothing may be
// computed before what it reads. A column emitted early would compute from the
// values the edit already invalidated, which is worse than not recomputing it
// at all: it would be wrong and it would look finished.
func TestDownstreamOfOrdersARecalculation(t *testing.T) {
	var g Graph
	mustBind(t, &g, "left", "base * 2")
	mustBind(t, &g, "right", "base + 1")
	mustBind(t, &g, "total", "left + right")

	for _, c := range []struct {
		col  string
		want []string
	}{
		{"base", []string{"left", "right", "total"}},
		{"left", []string{"total"}},
		{"right", []string{"total"}},
		{"total", nil},  // nothing reads it
		{"region", nil}, // a column no formula mentions
	} {
		t.Run(c.col, func(t *testing.T) {
			if got := g.DownstreamOf(c.col); !reflect.DeepEqual(got, c.want) {
				t.Errorf("DownstreamOf(%q) = %v, want %v", c.col, got, c.want)
			}
		})
	}
}

// A chain is the case where order is the whole answer: b has to be recomputed
// before c reads it.
func TestDownstreamOfFollowsAChain(t *testing.T) {
	var g Graph
	mustBind(t, &g, "b", "a * 2")
	mustBind(t, &g, "c", "b * 2")
	mustBind(t, &g, "d", "c + b")

	want := []string{"b", "c", "d"}
	if got := g.DownstreamOf("a"); !reflect.DeepEqual(got, want) {
		t.Errorf("DownstreamOf(a) = %v, want %v", got, want)
	}
}

// Editing a formula replaces what it depends on. An edge left behind by the
// expression someone just deleted would recalculate a column that no longer
// reads anything, and could refuse a binding for a cycle that is no longer
// there.
func TestRebindingReplacesTheOldDependencies(t *testing.T) {
	var g Graph
	mustBind(t, &g, "margin", "price * 2")
	mustBind(t, &g, "margin", "cost * 2")

	if got := g.DownstreamOf("price"); len(got) != 0 {
		t.Errorf("DownstreamOf(price) = %v, want nothing", got)
	}
	want := []string{"margin"}
	if got := g.DownstreamOf("cost"); !reflect.DeepEqual(got, want) {
		t.Errorf("DownstreamOf(cost) = %v, want %v", got, want)
	}
}

func contains(s []string, v string) bool {
	for _, c := range s {
		if c == v {
			return true
		}
	}
	return false
}
