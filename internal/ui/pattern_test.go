package ui

import (
	"image/color"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/canvas"
	"fyne.io/fyne/v2/theme"

	"github.com/flacyak/uno/internal/document"
	"github.com/flacyak/uno/internal/program"
	"github.com/flacyak/uno/internal/sheet"
)

// salesBody has enough separators in units for three to be fixed by hand and
// some to be left, which is the shape the recogniser exists for.
const salesBody = "date,region,units\n" +
	"2026-07-01,West,\"1,204\"\n" +
	"2026-07-01,East,987\n" +
	"2026-07-02,North,\"1,455\"\n" +
	"2026-07-02,South,\"2,038\"\n" +
	"2026-07-03,West,\"3,120\"\n" +
	"2026-07-03,East,\"4,001\"\n" +
	"2026-07-03,North,612\n"

func mustProg(t *testing.T, src string) program.Program {
	t.Helper()
	p, err := program.Parse(src)
	if err != nil {
		t.Fatalf("Parse(%q): %v", src, err)
	}
	return p
}

func loadedSales(t *testing.T) (*Shell, *workspace) {
	t.Helper()
	s := newTestShell(t)
	if err := s.load("sales.csv", strings.NewReader(salesBody)); err != nil {
		t.Fatalf("load: %v", err)
	}
	return s, s.active()
}

// fixThree makes the three edits the recogniser learns from, through the editor
// bar, which is the path a person takes. Committing an edit is what triggers the
// scan, so the bar is up by the time this returns.
func fixThree(t *testing.T, s *Shell, w *workspace) {
	t.Helper()
	edit(t, w, 0, 2, "1204")
	edit(t, w, 2, 2, "1455")
	edit(t, w, 3, 2, "2038")
	if !s.bar.box.Visible() {
		t.Fatal("no question after three consistent edits")
	}
}

// The third identical edit is the question the app should ask.
func TestThreeEditsRaiseTheQuestion(t *testing.T) {
	s, w := loadedSales(t)

	edit(t, w, 0, 2, "1204")
	if s.bar.box.Visible() {
		t.Fatal("the bar appeared after one edit")
	}
	edit(t, w, 2, 2, "1455")
	if s.bar.box.Visible() {
		t.Fatal("the bar appeared after two edits")
	}
	edit(t, w, 3, 2, "2038")
	if !s.bar.box.Visible() {
		t.Fatal("no question after the third edit")
	}

	// It names the column, what it would do, and how much of it, because nobody
	// can agree to a transformation they have only been told the name of.
	for _, want := range []string{"units", "remove commas", "2 more cells"} {
		if !strings.Contains(s.bar.text.Text, want) {
			t.Errorf("bar %q does not mention %q", s.bar.text.Text, want)
		}
	}
}

// Saying yes writes one operation, not one per cell.
func TestApplyingFixesTheRestAndFlipsTheBadge(t *testing.T) {
	s, w := loadedSales(t)

	fixThree(t, s, w)
	s.applyProposal(w)

	for row, want := range map[int]string{4: "3120", 5: "4001", 6: "612"} {
		if got := w.sheet.At(row, 2); got != want {
			t.Errorf("cell (%d,2) = %q, want %q", row, got, want)
		}
	}
	if c := w.sheet.Columns[2]; c.Kind != sheet.KindNum || c.Flagged {
		t.Errorf("units = %v flagged=%v, want num and unflagged", c.Kind, c.Flagged)
	}
	if got, want := badgeFor(w.sheet.Columns[2]), "num"; got != want {
		t.Errorf("badge = %q, want %q", got, want)
	}
	if got := w.sheet.EditCount(); got != 4 {
		t.Errorf("log = %d entries, want the three edits plus one operation", got)
	}
	if s.bar.box.Visible() {
		t.Error("the bar is still asking a question it has been answered")
	}
}

// costumeBody is the two other columns whose badge an apply can flip: money in
// a costume only some rows wear, and dates written with the wrong separator.
const costumeBody = "amount,closed\n" +
	"\"$1,204\",2026/07/01\n" +
	"$87,2026/07/02\n" +
	"\"$3,010\",2026/07/03\n" +
	"$450,2026/07/04\n" +
	"\"$12,900\",2026/07/05\n"

// The badge has to reach num and date, not only leave text?, or the offer and
// the badge are answering different questions about the same column.
func TestApplyingFlipsACurrencyAndADateColumn(t *testing.T) {
	s := newTestShell(t)
	if err := s.load("costumes.csv", strings.NewReader(costumeBody)); err != nil {
		t.Fatalf("load: %v", err)
	}
	w := s.active()

	for _, c := range []struct {
		col           int
		fixed         []string
		before, after string
		wantKind      sheet.Kind
	}{
		// A costume the badge knows to warn about, and one it does not: a
		// column of dates written the wrong way is not a number in disguise, so
		// nothing flags it, and the recogniser reaches it anyway.
		{0, []string{"1204", "87", "3010"}, "text?", "num", sheet.KindNum},
		{1, []string{"2026-07-01", "2026-07-02", "2026-07-03"}, "text", "date", sheet.KindDate},
	} {
		if got := badgeFor(w.sheet.Columns[c.col]); got != c.before {
			t.Errorf("column %d badge = %q before the fixes, want %q", c.col, got, c.before)
		}
		for row, v := range c.fixed {
			edit(t, w, row, c.col, v)
		}
		if !s.bar.box.Visible() {
			t.Fatalf("no question after three edits in column %d", c.col)
		}
		s.applyProposal(w)

		if got := w.sheet.Columns[c.col]; got.Kind != c.wantKind || got.Flagged {
			t.Errorf("column %d = %v flagged=%v, want %v unflagged",
				c.col, got.Kind, got.Flagged, c.wantKind)
		}
		if got := badgeFor(w.sheet.Columns[c.col]); got != c.after {
			t.Errorf("column %d badge = %q, want %q", c.col, got, c.after)
		}
	}

	// The rows nobody touched are the ones the offer was about.
	if got, want := w.sheet.At(4, 0), "12900"; got != want {
		t.Errorf("cell (4,0) = %q, want %q", got, want)
	}
	if got, want := w.sheet.At(4, 1), "2026-07-05"; got != want {
		t.Errorf("cell (4,1) = %q, want %q", got, want)
	}
}

// Everything applied can be undone as one step. This is the case undo replays
// for: there is no old value to put back, and there are four of them.
func TestOneUndoTakesTheWholeColumnBack(t *testing.T) {
	s, w := loadedSales(t)

	fixThree(t, s, w)
	s.applyProposal(w)

	s.undo()

	for row, want := range map[int]string{4: "3,120", 5: "4,001", 6: "612"} {
		if got := w.sheet.At(row, 2); got != want {
			t.Errorf("cell (%d,2) = %q, want %q back", row, got, want)
		}
	}
	// The three edits made by hand are before it in the log and stay done.
	if got := w.sheet.At(0, 2); got != "1204" {
		t.Errorf("cell (0,2) = %q, want the hand edit to survive", got)
	}
	if got := w.sheet.EditCount(); got != 3 {
		t.Errorf("log = %d entries, want the three edits", got)
	}
	if got, want := badgeFor(w.sheet.Columns[2]), "text?"; got != want {
		t.Errorf("badge = %q, want %q", got, want)
	}
}

// Saying not now silences that offer and nothing else.
func TestNotNowSuppressesThatProgramAndNoMore(t *testing.T) {
	s, w := loadedSales(t)

	fixThree(t, s, w)
	refused := w.proposal.Prog.String()

	s.dismissProposal(w)
	if s.bar.box.Visible() {
		t.Fatal("the bar survived being dismissed")
	}
	if got := w.dismissed[2]; got != refused {
		t.Errorf("dismissed[2] = %q, want the refused program %q", got, refused)
	}
	if w.sheet.EditCount() != 3 {
		t.Errorf("log = %d entries, want dismissal to write nothing", w.sheet.EditCount())
	}

	// Another edit in the same vein rescans, finds the same program, and must
	// not bring the refused offer back with it.
	edit(t, w, 5, 2, "4001")
	if s.bar.box.Visible() {
		t.Error("a refused offer came back on the next edit")
	}

	// A different question about the same column is still worth asking, which is
	// why the refusal is remembered against the program and not the column.
	w.dismissed[2] = mustProg(t, `trim()`).String()
	s.rescan(w)
	if !s.bar.box.Visible() {
		t.Error("a different offer for the same column was silenced with the first")
	}
}

// A file closed part-way through fixing a column asks the same question when it
// is opened again: the examples travel in the .uno, and so does what they mean.
func TestAReopenedWorkspaceStillAsks(t *testing.T) {
	s, w := loadedSales(t)
	fixThree(t, s, w)

	path := filepath.Join(t.TempDir(), "sales.uno")
	if err := document.Write(path, w.document()); err != nil {
		t.Fatalf("Write: %v", err)
	}

	fresh := newTestShell(t)
	if err := fresh.openURI(fileURI(t, path)); err != nil {
		t.Fatalf("open: %v", err)
	}
	reopened := fresh.active()

	// Opening is a scan, so the question is already on the screen.
	if !fresh.bar.box.Visible() {
		t.Fatal("a reopened workspace asks nothing")
	}
	if got, want := reopened.proposal.Prog.String(), `replace(/,/, "")`; got != want {
		t.Errorf("program = %q, want %q", got, want)
	}
	fresh.applyProposal(reopened)

	if got := reopened.sheet.At(4, 2); got != "3120" {
		t.Errorf("cell (4,2) = %q, want %q", got, "3120")
	}
	if got, want := badgeFor(reopened.sheet.Columns[2]), "num"; got != want {
		t.Errorf("badge = %q, want %q", got, want)
	}

	// Still one step back, on a file that has been to disk and come back.
	fresh.undo()
	if got := reopened.sheet.At(4, 2); got != "3,120" {
		t.Errorf("cell (4,2) = %q, want %q back", got, "3,120")
	}
}

// The preview's own file, end to end: three cells fixed by hand, the offer
// taken, the badge flipped, and one press putting all 3,149 of them back.
func TestTheWholeStoryOnTheRealFile(t *testing.T) {
	f, err := os.Open(filepath.Join("..", "..", "testdata", "sales-q3.csv"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer f.Close()

	s := newTestShell(t)
	if err := s.load("sales-q3.csv", f); err != nil {
		t.Fatalf("load: %v", err)
	}
	w := s.active()

	const units = 4
	if got, want := badgeFor(w.sheet.Columns[units]), "text?"; got != want {
		t.Fatalf("badge = %q, want %q", got, want)
	}

	edit(t, w, 0, units, "1204")
	edit(t, w, 2, units, "1455")
	edit(t, w, 4, units, "2038")

	if !s.bar.box.Visible() {
		t.Fatal("no question after three consistent edits")
	}
	if got, want := s.bar.text.Text, "units · remove commas from 3,149 more cells"; got != want {
		t.Errorf("bar = %q, want %q", got, want)
	}

	s.applyProposal(w)

	if got, want := badgeFor(w.sheet.Columns[units]), "num"; got != want {
		t.Errorf("badge = %q, want %q", got, want)
	}
	if got := w.sheet.EditCount(); got != 4 {
		t.Errorf("log = %d entries, want three edits and one operation", got)
	}
	if !strings.Contains(s.status.Text, "4 edits") {
		t.Errorf("status = %q, want it to count 4 edits", s.status.Text)
	}
	if got := w.sheet.At(5, units); got != "1101" {
		t.Errorf("cell (5,%d) = %q, want it fixed by the operation", units, got)
	}

	s.undo()

	if got, want := badgeFor(w.sheet.Columns[units]), "text?"; got != want {
		t.Errorf("badge = %q, want %q back", got, want)
	}
	if got := w.sheet.At(5, units); got != "1,101" {
		t.Errorf("cell (5,%d) = %q, want the separator back", units, got)
	}
	if got := w.sheet.At(0, units); got != "1204" {
		t.Errorf("cell (0,%d) = %q, want the hand edit to survive", units, got)
	}
}

// The bar arrives from below the window's bottom edge and leaves the same way,
// so where the offer came from is visible rather than inferred. The test driver
// runs an animation straight to its end, so what is asserted here is where the
// slide lands and not what it looks like on the way.
func TestTheBarSlidesInAndOut(t *testing.T) {
	s, w := loadedSales(t)

	if got := s.bar.lay.off; got != 1 {
		t.Errorf("resting offset = %v, want the bar below the window edge", got)
	}

	fixThree(t, s, w)
	if got := s.bar.lay.off; got != 0 {
		t.Errorf("offset with a question up = %v, want it fully risen", got)
	}

	s.dismissProposal(w)
	if got := s.bar.lay.off; got != 1 {
		t.Errorf("offset after an answer = %v, want it back below the edge", got)
	}
	if s.bar.box.Visible() {
		t.Error("the bar is still drawn after sliding out")
	}
}

// The offset is a fraction of the bar's own height, so 0 sits it on the bottom
// edge and 1 puts it exactly one bar below — off the window, where the window
// is what hides it and nothing has to clip.
func TestTheSlideLayoutPlacesTheBarOnTheBottomEdge(t *testing.T) {
	bar := canvas.NewRectangle(nil)
	bar.SetMinSize(fyne.NewSize(0, 40))
	objs := []fyne.CanvasObject{canvas.NewRectangle(nil), bar}

	l := &slideLayout{}
	l.Layout(objs, fyne.NewSize(300, 200))

	if got, want := objs[0].Size(), fyne.NewSize(300, 200); got != want {
		t.Errorf("window = %v, want the whole area at %v", got, want)
	}
	if got, want := bar.Position(), fyne.NewPos(0, 160); got != want {
		t.Errorf("risen bar at %v, want %v", got, want)
	}
	if got, want := bar.Size(), fyne.NewSize(300, 40); got != want {
		t.Errorf("bar = %v, want the window's width at %v", got, want)
	}

	l.off = 1
	l.place()
	if got, want := bar.Position(), fyne.NewPos(0, 200); got != want {
		t.Errorf("resting bar at %v, want %v — one bar below the edge", got, want)
	}
}

// A tab is not the only thing on screen, and the question belongs to the one
// being looked at.
func TestTheQuestionFollowsTheSelectedTab(t *testing.T) {
	s, w := loadedSales(t)
	fixThree(t, s, w)

	if err := s.load("other.csv", strings.NewReader(salesBody)); err != nil {
		t.Fatalf("load: %v", err)
	}
	if s.bar.box.Visible() {
		t.Error("the first tab's question followed the second tab")
	}

	s.tabs.Select(w.tab)
	if !s.bar.box.Visible() {
		t.Error("the question did not come back with its tab")
	}
}

// The window's content is built before the app has settled which theme variant
// it is running, so a bar that keeps the colours it was made with lays a
// near-black strip across a light grid.
func TestTheBarTakesItsColoursFromTheLiveTheme(t *testing.T) {
	s, w := loadedSales(t)
	if got := s.bar.bg.FillColor; got != color.Transparent {
		t.Fatalf("bar was painted at construction with %v", got)
	}

	fixThree(t, s, w)

	if got, want := s.bar.bg.FillColor, theme.Color(theme.ColorNameMenuBackground); got != want {
		t.Errorf("ground = %v, want the theme's menu surface %v", got, want)
	}
	if got, want := s.bar.edge.FillColor, theme.Color(theme.ColorNameSeparator); got != want {
		t.Errorf("edge = %v, want the theme's separator %v", got, want)
	}
	if s.bar.bg.FillColor == theme.Color(theme.ColorNameBackground) {
		t.Error("the bar is the same colour as the grid it floats over")
	}
}
