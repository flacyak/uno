# Extending the recogniser

Six changes. 1, 2 and 3 are independent of each other. 6 requires 4. Land them in order.

Each change lists the files to edit, the edit, the test to add, and the command that proves
it.

---

## 1. Describe the programs the lattice already emits

**Files:** `internal/program/parse.go`, `internal/program/program.go`

### Edit `charNames` in `parse.go`

Add the characters the deletion lattice produces:

```go
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
+	'*':  "asterisks",
+	'#':  "hashes",
+	'/':  "slashes",
+	'-':  "dashes",
+	'+':  "plus signs",
+	'(':  "brackets",
+	')':  "brackets",
+	'"':  "quotes",
+	'“':  "quotes",
+	'”':  "quotes",
 }
```

### Add `literalOf` and `isMeta` to `parse.go`

```go
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
```

### Teach `nameChars` in `parse.go` to read the anchors

`deletions` emits `^[...]+` and `[...]+$`. Strip the anchor, name the position:

```go
 func nameChars(src string) (string, bool) {
+	// The deletion lattice anchors its class rungs. Strip the anchor and say
+	// where it pointed, rather than refusing a program the recogniser offers.
+	where := ""
+	switch {
+	case strings.HasPrefix(src, "^") && strings.HasSuffix(src, "+"):
+		src, where = strings.TrimSuffix(src[1:], "+"), " from the start"
+	case strings.HasSuffix(src, "+$"):
+		src, where = strings.TrimSuffix(src, "+$"), " from the end"
+	}
+
 	body := src
 	if strings.HasPrefix(src, "[") && strings.HasSuffix(src, "]") {
 		body = src[1 : len(src)-1]
 	}
 	// ... the loop below, then:
 	if len(names) == 1 {
-		return names[0], true
+		return names[0] + where, true
 	}
-	return strings.Join(names[:len(names)-1], ", ") + " and " + names[len(names)-1], true
+	return strings.Join(names[:len(names)-1], ", ") + " and " + names[len(names)-1] + where, true
 }
```

### Teach the same loop to read the escapes `quoteClass` writes

`quoteClass` in `internal/pattern/induce.go` escapes `] \ ^ -` inside a class, so
the phone program's pattern is `[ ()\-]` and the loop has to walk past a backslash
to the character behind it. Only those four: `\d` and `\s` are character sets
rather than characters, and naming one of those is the regexp package's job.

The index has to be the loop's own for the escape to consume the next rune, so the
`range` becomes a counted loop and the negation guard moves with it:

```go
 	var names []string
 	seen := map[string]bool{}
-	for i, r := range []rune(body) {
-		// A backslash escape inside the class is still one character to a
-		// reader, but working out which one is the regexp package's job.
-		if r == '\\' {
-			return "", false
-		}
-		if r == '^' && i == 0 {
-			return "", false // a negated class means the opposite of what we would say
-		}
+	rs := []rune(body)
+	for i := 0; i < len(rs); i++ {
+		r := rs[i]
+		switch {
+		case r == '\\':
+			// quoteClass escapes these four inside a class, and they are still
+			// one character to a reader. Any other escape — \d, \s — is a
+			// character set rather than a character, and naming it is the
+			// regexp package's job.
+			if i++; i >= len(rs) || !strings.ContainsRune(`]\^-`, rs[i]) {
+				return "", false
+			}
+			r = rs[i]
+		case r == '^' && i == 0:
+			return "", false // a negated class means the opposite of what we would say
+		}
 		n, ok := charNames[r]
 		// ... unchanged
 	}
```

### Change `replaceStep.describe` in `program.go`

```go
 func (s replaceStep) describe() string {
 	what, ok := nameChars(s.src)
 	if !ok {
-		return s.String()
+		lit, isLit := literalOf(s.src)
+		if !isLit {
+			return s.String()
+		}
+		what = strconv.Quote(lit)
 	}
 	if s.lit == "" {
 		return "remove " + what
 	}
 	return fmt.Sprintf("replace %s with %q", what, s.lit)
 }
```

### Pin

Add to the `TestDescribe` table in `internal/program/program_test.go`, after the
rows it already names:

```go
// A literal the QuoteMeta in the lattice can be inverted out of, and the
// anchored class rungs that lattice emits.
{`replace(/ kg/, "")`, `remove " kg"`},
{`replace(/SKU-/, "")`, `remove "SKU-"`},
{`replace(/[*]+$/, "")`, "remove asterisks from the end"},
{`replace(/^[#]+/, "")`, "remove hashes from the start"},
{`replace(/\//, "-")`, `replace slashes with "-"`},
{`replace(/[ ()\-]/, "")`, "remove spaces, brackets and dashes"},
```

And one more to the fallback group below it, because a quantified escape is a
character set and there is nothing to name in it:

```go
{`replace(/\s+/, " ")`, `replace(/\s+/, " ")`},
```

### Verify

```
go test ./internal/program/
```

---

## 2. Offer `trim()` when whitespace sits at both ends

**File:** `internal/pattern/induce.go`, function `deletions`

### Add an `edges` flag

```go
 var (
 	out    []string
 	texts  = map[string]bool{}
 	chars  []rune
 	seen   = map[rune]bool{}
 	prefix = true
 	suffix = true
 	spaces = true
+	edges  = true // every run touches an end, not necessarily the same one
 )
```

### Test each run against the nearer edge

```go
 for _, d := range dels {
 	// ... existing texts/chars/spaces accumulation
-	if d.at != 0 {
-		prefix = false
-	}
-	if d.at+len([]rune(d.text)) != len(a) {
-		suffix = false
-	}
+	head := d.at == 0
+	tail := d.at+len([]rune(d.text)) == len(a)
+	if !head {
+		prefix = false
+	}
+	if !tail {
+		suffix = false
+	}
+	if !head && !tail {
+		edges = false
+	}
 }
```

`prefix` and `suffix` keep their present meaning and still gate the anchored class rungs.

### Gate `trim()` on `edges`

```go
-	if spaces && (prefix || suffix) {
+	// Both ends at once is the ordinary case and neither anchor covers it, so
+	// trim asks about the ends rather than about the anchor they share.
+	if spaces && edges {
 		out = append(out, "trim()")
 	}
```

### Pin

Add to `internal/pattern/pattern_test.go`. Two tests, because a quantity column and a name column ask different things of
this change. In the first, `trim()` and `replace(/[ ]/, "")` both explain the
examples and agree on every value in the column: what the change buys there is
that a proposal exists at all, and the assertion is the behaviour rather than
which of the two spellings the comparator picked. The second is where `trim()`
has to win on its own.

```go
func TestSpaceAtBothEndsIsATrim(t *testing.T) {
	s := oneCol(t, "qty", " 45 ", "  7 ", " 120  ", " 9 ")
	set(t, s, 0, 0, "45")
	set(t, s, 1, 0, "7")
	set(t, s, 2, 0, "120")

	// Removing every space and trimming the ends agree on every value in this
	// column, so it cannot say which was meant. What this pins is that there is
	// an offer at all: before, spaces at both ends satisfied neither anchor and
	// the column went unasked about. TestTrimmingANameColumn is where trim()
	// has to win.
	p, ok := propose(t, s)
	if !ok {
		t.Fatal("no proposal from three trims")
	}
	if got, want := p.Prog.Apply(" 9 "), "9"; got != want {
		t.Errorf("Apply = %q, want %q", got, want)
	}
}

// The value that separates trimming the ends from removing every space.
func TestTrimmingANameColumn(t *testing.T) {
	s := oneCol(t, "rep", " Ada Okafor ", " Bo Silva ", " Cy Tan ", " Di Vaz ")
	set(t, s, 0, 0, "Ada Okafor")
	set(t, s, 1, 0, "Bo Silva")
	set(t, s, 2, 0, "Cy Tan")

	p, ok := propose(t, s)
	if !ok {
		t.Fatal("no proposal from three trims")
	}
	if got, want := p.Prog.String(), "trim()"; got != want {
		t.Errorf("program = %s, want %s", got, want)
	}
	if got, want := p.Prog.Apply(" Di Vaz "), "Di Vaz"; got != want {
		t.Errorf("Apply = %q, want %q", got, want)
	}
}
```

### Verify

```
go test ./internal/pattern/
```

---

## 3. Induce one substitution applied many times

**File:** `internal/pattern/induce.go`, functions `rewrites` and `substitutions`

`replaceStep` already replaces every occurrence, so one rule covers `2026/09/03` →
`2026-09-03`.

### Widen the switch in `rewrites`

```go
 switch {
 case len(dels) > 0 && len(ins) == 0:
 	out = append(out, deletions(a, dels)...)
-case len(dels) == 1 && len(ins) == 1:
-	out = append(out, substitutions(dels[0], ins[0])...)
+case len(dels) == len(ins) && len(dels) > 0:
+	out = append(out, substitutions(dels, ins)...)
 }
```

### Take slices in `substitutions`, and require uniform runs

```go
-// substitutions generalises "this stretch became that one".
-func substitutions(d, i run) []string {
+// substitutions generalises "this stretch became that one", once or many times.
+// Many times only when it is the same stretch becoming the same thing, which is
+// one rule the person applied more than once: 2026/09/03 has two slashes and one
+// rule, and a value where two different stretches changed has no single rule in
+// it to find.
+func substitutions(dels, ins []run) []string {
+	d, i := dels[0], ins[0]
+	for _, r := range dels[1:] {
+		if r.text != d.text {
+			return nil
+		}
+	}
+	for _, r := range ins[1:] {
+		if r.text != i.text {
+			return nil
+		}
+	}
+
 	out := []string{replaceSrc(regexp.QuoteMeta(d.text), i.text)}

 	chars := []rune(d.text)
 	slices.Sort(chars)
 	chars = slices.Compact(chars)
 	out = append(out, replaceSrc("["+quoteClass(chars)+"]+", i.text))

 	if strings.TrimSpace(d.text) == "" {
 		out = append(out, replaceSrc(`\s+`, i.text))
 	}
 	return out
 }
```

### Pin

Add to `internal/pattern/pattern_test.go`. Import `internal/sheet` for the badge assertion:

```go
// A date column is the other one whose badge a fix can flip.
func TestProposesADateSeparator(t *testing.T) {
	s := oneCol(t, "closed", "2026/09/03", "2025/01/11", "2024/12/30", "2026/07/04")
	set(t, s, 0, 0, "2026-09-03")
	set(t, s, 1, 0, "2025-01-11")
	set(t, s, 2, 0, "2024-12-30")

	p, ok := propose(t, s)
	if !ok {
		t.Fatal("no proposal from three date separators")
	}
	// The literal /\// and the class /[\/]+/ both explain the examples and agree
	// on every value in the column, so the tiebreak picks between them and this
	// pins which one it picks.
	if got, want := p.Prog.String(), `replace(/[\/]+/, "-")`; got != want {
		t.Errorf("program = %s, want %s", got, want)
	}
	if err := s.Apply(p.Col, p.Prog); err != nil {
		t.Fatal(err)
	}
	if got, want := s.Columns[0].Kind, sheet.KindDate; got != want {
		t.Errorf("after apply, Kind = %v, want %v", got, want)
	}
}
```

### Verify

```
go test ./internal/pattern/
```

---

## 4. Generalise across the examples as well as within them

**Files:** `internal/pattern/induce.go`, `internal/pattern/pattern.go`

Intersecting programs asks what the examples have in common. A column whose decoration only
some rows wear has its answer in their union. Offer the union as an extra candidate;
`explains` decides whether it stands.

### Add `droppedChars` and `unionDeletion` to `induce.go`

```go
// droppedChars is every character the examples lost, across all of them.
// Insertions are ignored: a caller wanting a whole transformation checks that,
// a caller wanting a first step does not.
func droppedChars(ex []example) []rune {
	var chars []rune
	seen := map[rune]bool{}
	for _, e := range ex {
		a, b := []rune(e.was), []rune(e.now)
		if len(a) > maxDiff || len(b) > maxDiff {
			return nil
		}
		dels, _, ok := align(a, b)
		if !ok {
			return nil
		}
		for _, d := range dels {
			for _, r := range d.text {
				if !seen[r] {
					seen[r] = true
					chars = append(chars, r)
				}
			}
		}
	}
	slices.Sort(chars)
	return chars
}

// unionDeletion is droppedChars as a candidate, for the columns whose decoration
// only some rows wear: $1,204 offers [$,] and $87 offers [$], the intersection of
// those two is empty, and [$,] is what both meant.
//
// This is the one reading that is not intersected, so it is offered rather than
// concluded: explains decides whether it stands.
func unionDeletion(ex []example) []string {
	for _, e := range ex {
		if _, ins, ok := align([]rune(e.was), []rune(e.now)); !ok || len(ins) > 0 {
			return nil
		}
	}
	chars := droppedChars(ex)
	if len(chars) == 0 {
		return nil
	}
	return []string{replaceSrc("["+quoteClass(chars)+"]", "")}
}
```

### Give a witness an optional whole-set rung in `pattern.go`

```go
-var witnesses = []func(was, now string) []string{rewrites, restructures}
+// witness is the two ways to read a set of examples: one at a time, whose
+// candidate sets are intersected, and all at once, whose candidates are not.
+// Intersecting asks what the examples have in common, which is the right
+// question and the whole of the design — but a column whose decoration only some
+// rows wear has its answer in their union instead. together is nil for a witness
+// with no such reading.
+type witness struct {
+	each     func(was, now string) []string
+	together func(ex []example) []string
+}
+
+var witnesses = []witness{
+	{each: rewrites, together: unionDeletion},
+	{each: restructures},
+}
```

The doc comment above `witnesses` is about the order the two are tried in, which
is unchanged, so it stays on the var and the new one goes on the type.

### Take the struct in `proposeFrom`, and dedupe before ranking

The two readings can land on the same program — they do for
`TestARunnerUpThatDisagreesMakesItAmbiguous`, where both yield
`replace(/[,]/, "")`. A duplicate at the top of the ranking would have
`disagree` compare a program with itself and report a column unambiguous that is
not, so the keeping loop takes each program's text once.

```go
-func (c column) proposeFrom(witness func(was, now string) []string) (Proposal, bool) {
-	var kept []program.Program
-	for _, p := range induce(c.examples, witness) {
-		if c.explains(p) {
-			kept = append(kept, p)
-		}
-	}
+func (c column) proposeFrom(w witness) (Proposal, bool) {
+	cands := induce(c.examples, w.each)
+	if w.together != nil {
+		cands = append(cands, parseAll(w.together(c.examples))...)
+	}
+
+	// ... the existing note on why verification is separate from induction, then:
+	//
+	// The two readings can land on the same program, and a duplicate at the top
+	// of the ranking would compare a program with itself and report a column
+	// unambiguous that is not.
+	var kept []program.Program
+	seen := map[string]bool{}
+	for _, p := range cands {
+		if s := p.String(); !seen[s] && c.explains(p) {
+			seen[s] = true
+			kept = append(kept, p)
+		}
+	}
 	// ... rest unchanged
```

### Pin

```go
// The decoration a column wears is not worn by every row in it, and the three
// rows a person demonstrates on are not chosen to be representative.
func TestOneDemonstrationCellWithoutTheSeparator(t *testing.T) {
	s := oneCol(t, "amount", "$1,204", "$87", "$3,010", "$450", "$12,900")
	set(t, s, 0, 0, "1204")
	set(t, s, 1, 0, "87") // under a thousand: no comma to remove
	set(t, s, 2, 0, "3010")

	p, ok := propose(t, s)
	if !ok {
		t.Fatal("no proposal from three currency fixes")
	}
	if got, want := p.Prog.String(), `replace(/[$,]/, "")`; got != want {
		t.Errorf("program = %s, want %s", got, want)
	}
	if got, want := p.Prog.Apply("$12,900"), "12900"; got != want {
		t.Errorf("Apply = %q, want %q", got, want)
	}
}
```

### Verify

Run the whole package. `TestARunnerUpThatDisagreesMakesItAmbiguous` pins the
narrowest-claim-wins ranking and is the test to watch here:

```
go test ./internal/pattern/ -run 'TestOneDemonstrationCell|TestARunnerUp|TestThreeFixedCells'
go test ./...
```

---

## 5. Make the badge agree with the offer

**File:** `internal/sheet/kind.go`

`inferKind`'s flagged test is comma-only while the offer is general. Widen it to the same
decoration set.

### Add `decoration` and `undress`

```go
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
```

### Use it in `inferKind`

```go
-		case isNumber(strings.ReplaceAll(v, ",", "")):
+		case isNumber(undress(v)):
 			formatted++
```

The doc comment above `inferKind` names the convention it is being strict about,
so it names the wider set now: *a separator, a currency mark, a percent sign*.

### Pin

Add to `internal/sheet/sheet_test.go`, in the style of `TestInferKind`:

```go
// The costume a number wears is not always a comma.
func TestInferKindFlagsTheOtherDecorations(t *testing.T) {
	s := New("t.csv",
		[]string{"amount", "rate", "swiss", "spaced", "mixed"},
		[][]string{
			{"$1,204", "12.5%", "1'204", "1 204", "$1,204"},
			{"$87", "3%", "9'870", "9 870", "N/A"},
			{"$3,010", "88.1%", "2'000", "2 000", "$3,010"},
		},
	)

	for _, c := range []struct {
		col         int
		wantKind    Kind
		wantFlagged bool
	}{
		{0, KindText, true}, // currency and separators
		{1, KindText, true}, // percent
		{2, KindText, true}, // apostrophe separator
		{3, KindText, true}, // space separator
		{4, KindText, false}, // a genuine non-number keeps it mixed
	} {
		got := s.Columns[c.col]
		if got.Kind != c.wantKind || got.Flagged != c.wantFlagged {
			t.Errorf("column %q: kind=%v flagged=%v, want kind=%v flagged=%v",
				got.Header, got.Kind, got.Flagged, c.wantKind, c.wantFlagged)
		}
	}
}
```

`TestInferKind` and `TestInferKindDoesNotFlagGenuinelyMixedColumns` must both still pass:
`decoration` leaves `.` out, so `48160.00` stays `KindNum` and `N/A` still sinks a column.

### Verify

```
go test ./internal/sheet/
```

---

## 6. Compose two steps

**File:** `internal/pattern/pattern.go`, which gains a `regexp` import

Requires change 4 — `compose` uses `droppedChars`.

A first step comes from the characters the examples lost, not from a lattice that has to
explain them. It leaves a shape the second step reads the same way in every row.

### Extract the ranking tail of `proposeFrom` into `rank`

Everything in `proposeFrom` from `slices.SortFunc(kept, bySize)` onward moves verbatim into:

```go
// rank keeps the candidates that reproduce the examples and returns the best of
// them as the question to ask.
func (c column) rank(cands []program.Program) (Proposal, bool) {
	// ... the keeping loop from change 4, then the existing sort, cap, survey,
	// ranking and Proposal construction
}
```

`proposeFrom` becomes the induction and nothing else:

```go
func (c column) proposeFrom(w witness) (Proposal, bool) {
	cands := induce(c.examples, w.each)
	if w.together != nil {
		cands = append(cands, parseAll(w.together(c.examples))...)
	}
	return c.rank(cands)
}
```

### Add `compose`

```go
// maxFirstSteps bounds the fan-out. Each candidate costs a full induction over
// every example.
const maxFirstSteps = 8

// compose builds the two-step programs, by clearing characters first and reading
// what is left second. The first step comes from the characters the examples
// lost rather than from a lattice that has to explain them, and what it leaves
// is a shape the second step reads the same way in every row: (1,204) and (87)
// have no decomposition in common until the comma is gone, and 1.204,50 and
// 9.870,25 have no substitution in common until the full stop is.
func compose(ex []example) []program.Program {
	chars := droppedChars(ex)
	if len(chars) == 0 || len(chars) > maxFirstSteps {
		return nil
	}

	firsts := make([]string, 0, len(chars)+1)
	for _, r := range chars {
		firsts = append(firsts, replaceSrc(regexp.QuoteMeta(string(r)), ""))
	}
	if len(chars) > 1 {
		firsts = append(firsts, replaceSrc("["+quoteClass(chars)+"]", ""))
	}

	var out []program.Program
	for _, first := range parseAll(firsts) {
		rest := make([]example, len(ex))
		for i, e := range ex {
			rest[i] = example{was: first.Apply(e.was), now: e.now}
		}
		for _, w := range witnesses {
			for _, second := range induce(rest, w.each) {
				if len(first)+len(second) > program.MaxSteps {
					continue
				}
				out = append(out, append(slices.Clone(first), second...))
			}
		}
	}
	return out
}
```

### Call it last in `propose`

```go
 func (c column) propose() (Proposal, bool) {
 	for _, w := range witnesses {
 		if p, ok := c.proposeFrom(w); ok {
 			return p, true
 		}
 	}
-	return Proposal{}, false
+	// Two steps where one will not do. The ranking comparator sorts by step
+	// count first, so a one-step program keeps its precedence and this is only
+	// ever reached by a column no single step explains.
+	return c.rank(compose(c.examples))
 }
```

### Pin

```go
func TestProposesAParenthesisedNegative(t *testing.T) {
	s := oneCol(t, "delta", "(1,204)", "(87)", "(3,010)", "(450)")
	set(t, s, 0, 0, "-1204")
	set(t, s, 1, 0, "-87")
	set(t, s, 2, 0, "-3010")

	p, ok := propose(t, s)
	if !ok {
		t.Fatal("no proposal from three parenthesised negatives")
	}
	if got, want := len(p.Prog), 2; got != want {
		t.Fatalf("program %s has %d steps, want %d", p.Prog, got, want)
	}
	if got, want := p.Prog.Apply("(450)"), "-450"; got != want {
		t.Errorf("Apply = %q, want %q", got, want)
	}
}

func TestProposesAEuropeanDecimal(t *testing.T) {
	s := oneCol(t, "amount", "1.204,50", "9.870,25", "2.000,00", "3.150,75")
	set(t, s, 0, 0, "1204.50")
	set(t, s, 1, 0, "9870.25")
	set(t, s, 2, 0, "2000.00")

	p, ok := propose(t, s)
	if !ok {
		t.Fatal("no proposal from three European decimals")
	}
	if got, want := p.Prog.Apply("3.150,75"), "3150.75"; got != want {
		t.Errorf("Apply = %q, want %q", got, want)
	}
}

// A one-step answer keeps its precedence over a two-step one.
func TestCommasStayOneStep(t *testing.T) {
	s := oneCol(t, "units", "1,204", "9,870", "3,010", "5,500")
	set(t, s, 0, 0, "1204")
	set(t, s, 1, 0, "9870")
	set(t, s, 2, 0, "3010")

	p, ok := propose(t, s)
	if !ok {
		t.Fatal("no proposal")
	}
	if got, want := len(p.Prog), 1; got != want {
		t.Errorf("program %s has %d steps, want %d", p.Prog, got, want)
	}
}
```

### Verify

```
go test ./internal/pattern/
go test ./...
```

---

## The whole set, once landed

Add to `internal/pattern/pattern_test.go`.

Three rows pin a tiebreak rather than a conclusion, and say so. `trim()`,
`/[\/]+/` and `end(/@/, -1)` each have a rival that explains the same examples
and agrees on every value in its column, so which of the two is offered is
settled by the comparator and not by the evidence. The trim row is a name column
for that reason: the interior space is what makes removing every space fail
`explains`, and leaves `trim()` the only survivor.

```go
// Each row is three demonstrated edits, the program they induce, and one
// untouched value the program then claims.
func TestTheShapesTheRecogniserReaches(t *testing.T) {
	for _, c := range []struct {
		name    string
		values  []string // the column; the first three get edited
		fixed   []string // what the person typed into them
		want    string   // the program, in its text form
		in, out string   // a value nobody touched, and what applying does to it
	}{
		{"commas", []string{"1,204", "9,870", "3,010", "5,500"},
			[]string{"1204", "9870", "3010"}, `replace(/,/, "")`, "5,500", "5500"},
		{"currency", []string{"$1,204", "$87", "$3,010", "$5,500"},
			[]string{"1204", "87", "3010"}, `replace(/[$,]/, "")`, "$5,500", "5500"},
		{"percent", []string{"12.5%", "3%", "88.1%", "40%"},
			[]string{"12.5", "3", "88.1"}, `replace(/%/, "")`, "40%", "40"},
		{"units", []string{"45 kg", "7 kg", "120 kg", "9 kg"},
			[]string{"45", "7", "120"}, `replace(/ kg/, "")`, "9 kg", "9"},
		{"footnote", []string{"1204*", "87*", "310*", "55*"},
			[]string{"1204", "87", "310"}, `replace(/[*]+$/, "")`, "55*", "55"},
		{"swiss separator", []string{"1'204", "9'870", "2'000", "3'150"},
			[]string{"1204", "9870", "2000"}, `replace(/'/, "")`, "3'150", "3150"},
		{"id prefix", []string{"SKU-00421", "SKU-00887", "SKU-01930", "SKU-00042"},
			[]string{"00421", "00887", "01930"}, `replace(/SKU-/, "")`, "SKU-00042", "00042"},
		{"phone", []string{"(555) 123-4567", "(212) 999-1000", "(310) 555-0101", "(415) 200-3000"},
			[]string{"5551234567", "2129991000", "3105550101"},
			`replace(/[ ()\-]/, "")`, "(415) 200-3000", "4152003000"},
		{"case fold", []string{"ca", "ny", "tx", "wa"},
			[]string{"CA", "NY", "TX"}, `upper()`, "wa", "WA"},
		// "after the last @" and "after the first @" agree on every value here,
		// so the tiebreak picks between them and this pins which.
		{"email domain", []string{"ada@corp.com", "bo@acme.io", "cy@x.net", "di@q.org"},
			[]string{"corp.com", "acme.io", "x.net"},
			`slice(end(/@/, -1), len)`, "di@q.org", "q.org"},
		// A name column rather than a quantity one: the interior space is what
		// separates trimming the ends from removing every space.
		{"trim", []string{" Ada Okafor ", " Bo Silva ", " Cy Tan ", " Di Vaz "},
			[]string{"Ada Okafor", "Bo Silva", "Cy Tan"}, `trim()`, " Di Vaz ", "Di Vaz"},
		{"date separator", []string{"2026/09/03", "2025/01/11", "2024/12/30", "2026/07/04"},
			[]string{"2026-09-03", "2025-01-11", "2024-12-30"},
			`replace(/[\/]+/, "-")`, "2026/07/04", "2026-07-04"},
	} {
		t.Run(c.name, func(t *testing.T) {
			s := oneCol(t, "col", c.values...)
			for row, v := range c.fixed {
				set(t, s, row, 0, v)
			}

			p, ok := propose(t, s)
			if !ok {
				t.Fatal("no proposal from three edits")
			}
			if got := p.Prog.String(); got != c.want {
				t.Errorf("program = %s, want %s", got, c.want)
			}
			if got := p.Prog.Apply(c.in); got != c.out {
				t.Errorf("Apply(%q) = %q, want %q", c.in, got, c.out)
			}
		})
	}
}
```

---

## End to end

Add `TestApplyingFlipsACurrencyAndADateColumn` to `internal/ui/pattern_test.go`,
beside `TestApplyingFixesTheRestAndFlipsTheBadge` and on a fixture of its own:
seven tests share `salesBody` and its column-2 offset, and this one needs two
columns of its own shape. Three edits in each, one apply each, and the badge
asserted before and after.

Before matters as much as after, and the two columns differ there. A column of
`$1,204` is flagged — that is change 5 — and reads `text?`. A column of
`2026/07/01` is not: it is not a number in a costume, nothing in `inferKind`
claims it, and it reads a plain `text`. The recogniser reaches it anyway, which
is the point of asserting both.

```go
const costumeBody = "amount,closed\n" +
	"\"$1,204\",2026/07/01\n" +
	"$87,2026/07/02\n" +
	"\"$3,010\",2026/07/03\n" +
	"$450,2026/07/04\n" +
	"\"$12,900\",2026/07/05\n"
```

| column | before | fixed by hand | after |
| --- | --- | --- | --- |
| `amount` | `text?` | `1204`, `87`, `3010` | `num` |
| `closed` | `text` | the first three as `2026-07-0n` | `date` |

Row 4 is the one nobody touched: `$12,900` has to end as `12900` and
`2026/07/05` as `2026-07-05`.

Then, by hand:

```
go run . testdata/sales-q3.csv
```

Open a CSV with a `$`-and-comma column. Edit three cells, including one under $1,000.
The bar reads `remove dollar signs and commas`. Press Apply. The badge reads `num`.
Press undo once; the column comes back.
