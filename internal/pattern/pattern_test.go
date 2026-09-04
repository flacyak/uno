package pattern

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/flacyak/uno/internal/ingest"
	"github.com/flacyak/uno/internal/sheet"
)

// oneCol builds a sheet of a single column, which is the shape most of what the
// recogniser does is about.
func oneCol(t *testing.T, header string, values ...string) *sheet.Sheet {
	t.Helper()
	rows := make([][]string, len(values))
	for i, v := range values {
		rows[i] = []string{v}
	}
	return sheet.New("test.csv", []string{header}, rows)
}

func set(t *testing.T, s *sheet.Sheet, row, col int, v string) {
	t.Helper()
	if err := s.Set(row, col, v); err != nil {
		t.Fatalf("Set(%d,%d,%q): %v", row, col, v, err)
	}
}

func propose(t *testing.T, s *sheet.Sheet) (Proposal, bool) {
	t.Helper()
	return Snap(s).Propose()
}

// sales opens the file the preview is filmed from, which is the case the whole
// recogniser exists for: 3,152 of 4,812 rows in units wear a thousands
// separator, and fixing them by hand is the work uno is meant to remove.
func sales(t *testing.T) *sheet.Sheet {
	t.Helper()
	f, err := os.Open(filepath.Join("..", "..", "testdata", "sales-q3.csv"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer f.Close()

	s, err := ingest.Read("sales-q3.csv", f)
	if err != nil {
		t.Fatalf("ingest: %v", err)
	}
	return s
}

const unitsCol = 4

func TestThreeFixedCellsProposeTheRest(t *testing.T) {
	s := sales(t)
	if c := s.Columns[unitsCol]; !c.Flagged {
		t.Fatalf("units = %v flagged=%v, want the warning badge on", c.Kind, c.Flagged)
	}

	// Rows 0, 2 and 4 are the first three holding a separator.
	set(t, s, 0, unitsCol, "1204")
	set(t, s, 2, unitsCol, "1455")
	set(t, s, 4, unitsCol, "2038")

	p, ok := propose(t, s)
	if !ok {
		t.Fatal("no proposal after three consistent edits")
	}
	if p.Col != unitsCol || p.Header != "units" {
		t.Errorf("proposal names column %d %q, want %d units", p.Col, p.Header, unitsCol)
	}
	if got, want := p.Prog.String(), `replace(/,/, "")`; got != want {
		t.Errorf("program = %q, want %q", got, want)
	}
	if got, want := p.Prog.Describe(), "remove commas"; got != want {
		t.Errorf("describe = %q, want %q", got, want)
	}

	// 3,152 rows carry a separator and three of them have been fixed by hand.
	// Offering to redo those would count the person's own work as the app's.
	if got, want := p.Affects, 3149; got != want {
		t.Errorf("Affects = %d, want %d", got, want)
	}
	if p.Ambiguous {
		t.Error("proposal is ambiguous, want a confident one")
	}
	if len(p.Sample) != SampleSize {
		t.Errorf("Sample = %d rows, want %d", len(p.Sample), SampleSize)
	}
	for _, c := range p.Sample {
		if c.Was == c.Now {
			t.Errorf("sample row %d shows no change", c.Row)
		}
	}
}

// Applying the proposal is what ends it: nothing in the column still matches, so
// the recogniser has nothing left to ask about and does not nag.
func TestApplyingAProposalSettlesTheColumn(t *testing.T) {
	s := sales(t)
	set(t, s, 0, unitsCol, "1204")
	set(t, s, 2, unitsCol, "1455")
	set(t, s, 4, unitsCol, "2038")

	p, ok := propose(t, s)
	if !ok {
		t.Fatal("no proposal")
	}
	if err := s.Apply(p.Col, p.Prog); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if c := s.Columns[unitsCol]; c.Kind != sheet.KindNum || c.Flagged {
		t.Errorf("units = %v flagged=%v, want num and unflagged", c.Kind, c.Flagged)
	}
	if _, ok := propose(t, s); ok {
		t.Error("a second proposal after the column was fixed")
	}
}

// Two is a coincidence often enough to be annoying. The third is the one that
// says this is a habit.
func TestTwoExamplesAreNotEnough(t *testing.T) {
	s := oneCol(t, "units", "1,204", "987", "1,455", "2,038")
	set(t, s, 0, 0, "1204")
	set(t, s, 2, 0, "1455")

	if p, ok := propose(t, s); ok {
		t.Errorf("proposed %q from two examples", p.Prog)
	}
}

// Someone fixing a column wanders off to another one and comes back. A
// recogniser that only read the tail of the log would never see the pattern.
func TestExamplesNeedNotBeAdjacentInTheLog(t *testing.T) {
	s := sheet.New("t.csv", []string{"region", "units"}, [][]string{
		{"West", "1,204"},
		{"East", "987"},
		{"North", "1,455"},
		{"South", "2,038"},
		{"West", "3,120"},
		{"East", "4,001"},
	})

	set(t, s, 0, 1, "1204")
	set(t, s, 0, 0, "west") // a detour into another column
	set(t, s, 2, 1, "1455")
	set(t, s, 1, 0, "east")
	set(t, s, 3, 1, "2038")

	p, ok := propose(t, s)
	if !ok {
		t.Fatal("no proposal from three nonconsecutive edits")
	}
	if p.Col != 1 {
		t.Errorf("proposal names column %d, want 1", p.Col)
	}
	if got, want := p.Prog.String(), `replace(/,/, "")`; got != want {
		t.Errorf("program = %q, want %q", got, want)
	}
}

// A cell edited twice contributes one example, from what it held before the
// first edit to what it holds after the last. The value in between was a
// keystroke, not a demonstration.
func TestRepeatedEditsOfOneCellAreOneExample(t *testing.T) {
	s := oneCol(t, "units", "1,204", "1,455", "2,038", "3,001")
	set(t, s, 0, 0, "1204x")
	set(t, s, 0, 0, "1204") // corrected in place
	set(t, s, 1, 0, "1455")
	set(t, s, 2, 0, "2038")

	p, ok := propose(t, s)
	if !ok {
		t.Fatal("no proposal")
	}
	if got, want := p.Prog.String(), `replace(/,/, "")`; got != want {
		t.Errorf("program = %q, want %q", got, want)
	}
}

// A value typed and then typed back is not a demonstration of anything.
func TestACellEditedBackIsNotAnExample(t *testing.T) {
	s := oneCol(t, "units", "1,204", "1,455", "2,038", "3,001")
	set(t, s, 0, 0, "1204")
	set(t, s, 1, 0, "1455")
	set(t, s, 2, 0, "2038x")
	set(t, s, 2, 0, "2,038") // back to where it started

	if p, ok := propose(t, s); ok {
		t.Errorf("proposed %q from two examples and a retraction", p.Prog)
	}
}

// A program has to reproduce every example, not most of them. One edit that does
// not fit is the person saying the rule is not what it looked like.
func TestOneInconsistentExampleSinksTheProposal(t *testing.T) {
	s := oneCol(t, "units", "1,204", "1,455", "2,038", "3,001")
	set(t, s, 0, 0, "1204")
	set(t, s, 1, 0, "1455")
	set(t, s, 2, 0, "n/a")

	if p, ok := propose(t, s); ok {
		t.Errorf("proposed %q despite an example it cannot reproduce", p.Prog)
	}
}

// The examples an apply generalised describe characters that are no longer
// there. Reading them again would be inducing a rule from the results of a rule.
func TestAnAppliedColumnStopsBeingEvidence(t *testing.T) {
	s := oneCol(t, "units", "1,204", "1,455", "2,038", "3,001")
	set(t, s, 0, 0, "1204")
	set(t, s, 1, 0, "1455")
	set(t, s, 2, 0, "2038")

	p, ok := propose(t, s)
	if !ok {
		t.Fatal("no proposal")
	}
	if err := s.Apply(0, p.Prog); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if len(gather(s.Edits())) != 0 {
		t.Errorf("examples survived the apply: %v", gather(s.Edits()))
	}
}

// The examples do not always settle which rule was meant. When the runner-up
// parts company with the winner somewhere in the column, the offer has to say so
// rather than pick and hope.
func TestARunnerUpThatDisagreesMakesItAmbiguous(t *testing.T) {
	// Every example loses a trailing comma. Whether that means "the trailing
	// one" or "all of them" is not decidable from these three, and the column
	// holds a row where the two answers differ.
	s := oneCol(t, "code", "AB,", "CD,", "EF,", "G,H,", "J,K")
	set(t, s, 0, 0, "AB")
	set(t, s, 1, 0, "CD")
	set(t, s, 2, 0, "EF")

	p, ok := propose(t, s)
	if !ok {
		t.Fatal("no proposal")
	}
	if !p.Ambiguous {
		t.Errorf("program %q is not marked ambiguous", p.Prog)
	}

	// The narrower claim wins: removing the trailing comma leaves the one in
	// the middle of G,H alone, and rewriting it was never demonstrated.
	if got, want := p.Prog.Apply("G,H,"), "G,H"; got != want {
		t.Errorf("Apply(%q) = %q, want the conservative %q", "G,H,", got, want)
	}
	if got, want := p.Prog.Apply("J,K"), "J,K"; got != want {
		t.Errorf("Apply(%q) = %q, want it left alone at %q", "J,K", got, want)
	}
}

// Not every consistent edit is a transformation. Three cells typed over with
// unrelated values describe nothing, and the right answer is silence.
func TestUnrelatedEditsProposeNothing(t *testing.T) {
	s := oneCol(t, "note", "alpha", "beta", "gamma", "delta")
	set(t, s, 0, 0, "one")
	set(t, s, 1, 0, "two")
	set(t, s, 2, 0, "three")

	if p, ok := propose(t, s); ok {
		t.Errorf("proposed %q from unrelated edits", p.Prog)
	}
}

// A program that explains the examples and claims nothing else is not a
// question worth asking.
func TestNothingLeftToChangeProposesNothing(t *testing.T) {
	s := oneCol(t, "units", "1,204", "1,455", "2,038", "987")
	set(t, s, 0, 0, "1204")
	set(t, s, 1, 0, "1455")
	set(t, s, 2, 0, "2038")

	if p, ok := propose(t, s); ok {
		t.Errorf("proposed %q with nothing left for it to do", p.Prog)
	}
}

// Not every fix changes characters. Pulling the code out of the middle of a cell
// leaves every character it keeps exactly as it was, and no amount of replacing
// describes it.
func TestProposesAnExtraction(t *testing.T) {
	s := oneCol(t, "rep",
		"Ada (West)", "Ben (East)", "Cai (North)", "Dee (South)", "Eli (West)")
	set(t, s, 0, 0, "West")
	set(t, s, 1, 0, "East")
	set(t, s, 2, 0, "North")

	p, ok := propose(t, s)
	if !ok {
		t.Fatal("no proposal from three extractions")
	}
	for in, want := range map[string]string{
		"Dee (South)": "South",
		"Eli (West)":  "West",
	} {
		if got := p.Prog.Apply(in); got != want {
			t.Errorf("%s: Apply(%q) = %q, want %q", p.Prog, in, got, want)
		}
	}
	if got, want := p.Affects, 2; got != want {
		t.Errorf("Affects = %d, want %d", got, want)
	}
}

// The same characters in a different order is the case a pipeline of rewrites
// cannot reach at all.
func TestProposesAReordering(t *testing.T) {
	s := oneCol(t, "rep",
		"Okafor, Ada", "Iyer, Ben", "Moreau, Cai", "Nakamura, Dee")
	set(t, s, 0, 0, "Ada Okafor")
	set(t, s, 1, 0, "Ben Iyer")
	set(t, s, 2, 0, "Cai Moreau")

	p, ok := propose(t, s)
	if !ok {
		t.Fatal("no proposal from three reorderings")
	}
	if got, want := p.Prog.Apply("Nakamura, Dee"), "Dee Nakamura"; got != want {
		t.Errorf("%s: Apply = %q, want %q", p.Prog, got, want)
	}
}

// A cell holding prose has no convention in it to induce from, and aligning two
// paragraphs is work spent to discover that.
func TestVeryLongValuesAreNotAligned(t *testing.T) {
	long := strings.Repeat("a,", 200)
	s := oneCol(t, "note", long, long, long, long)
	set(t, s, 0, 0, strings.ReplaceAll(long, ",", ""))
	set(t, s, 1, 0, strings.ReplaceAll(long, ",", ""))
	set(t, s, 2, 0, strings.ReplaceAll(long, ",", ""))

	if p, ok := propose(t, s); ok {
		t.Errorf("proposed %q from values past the alignment bound", p.Prog)
	}
}

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
