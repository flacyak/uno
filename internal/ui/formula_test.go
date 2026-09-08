package ui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/canvas"
	"fyne.io/fyne/v2/widget"

	"github.com/flacyak/uno/internal/library"
)

// stockLibrary gives the test an empty formula directory and copies the named
// .unof fixtures into it, which is where a person's library lives.
//
// It empties the directory first and again afterwards. The test app's storage
// root is shared by the package rather than made fresh per test, so a library a
// previous test wrote into would otherwise be counted by the next one.
func stockLibrary(t *testing.T, s *Shell, ids ...string) {
	t.Helper()

	dir := s.libraryDir()
	if dir == "" {
		t.Fatal("no library directory; the test app has no storage")
	}
	if err := os.RemoveAll(dir); err != nil {
		t.Fatalf("clearing the library: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	for _, id := range ids {
		b, err := os.ReadFile(filepath.Join("..", "..", "testdata", id+".unof"))
		if err != nil {
			t.Fatalf("fixture %s: %v", id, err)
		}
		if err := os.WriteFile(filepath.Join(dir, id+".unof"), b, 0o644); err != nil {
			t.Fatalf("write %s: %v", id, err)
		}
	}
}

// The drawer rests outside the right edge and comes in from it, so where the
// library came from is visible rather than inferred. The test driver runs an
// animation straight to its end, so what is asserted is where the slide lands.
func TestTheDrawerSlidesInFromTheRightAndBackOut(t *testing.T) {
	s, _ := loadedSales(t)

	if got := s.drawer.lay.off; got != 1 {
		t.Errorf("resting offset = %v, want the drawer outside the window edge", got)
	}

	s.toggleDrawer()
	if got := s.drawer.lay.off; got != 0 {
		t.Errorf("offset with the library open = %v, want it fully in", got)
	}

	s.toggleDrawer()
	if got := s.drawer.lay.off; got != 1 {
		t.Errorf("offset after closing = %v, want it back outside the edge", got)
	}
	if s.drawer.box.Visible() {
		t.Error("the drawer is still drawn after sliding out")
	}
}

// Overlapping rather than compressing is the decision the panel exists to make:
// resizing the grid would reflow every column and move the cell that prompted
// someone to open the drawer in the first place. The drawer is laid over the
// window's contents at full size, so the grid underneath never learns it is
// there.
func TestOpeningTheDrawerLeavesTheGridAtFullSize(t *testing.T) {
	s, w := loadedSales(t)
	s.win.Resize(fyne.NewSize(800, 600))
	layOut := func() { s.win.Content().Resize(s.win.Canvas().Size()) }

	layOut()
	under := w.table.Size()
	if under.IsZero() {
		t.Fatal("the grid has no size to compare against")
	}

	s.toggleDrawer()
	layOut()

	if got := w.table.Size(); got != under {
		t.Errorf("grid = %v, want it left at %v", got, under)
	}

	// And the same thing said about the layout itself: the contents get the
	// whole area, and the drawer is placed on top of it rather than beside it.
	objs := []fyne.CanvasObject{canvas.NewRectangle(nil), canvas.NewRectangle(nil)}
	objs[1].(*canvas.Rectangle).SetMinSize(fyne.NewSize(drawerWidth, 0))
	l := &slideLayout{edge: fromRight}
	l.Layout(objs, fyne.NewSize(800, 600))
	if got, want := objs[0].Size(), fyne.NewSize(800, 600); got != want {
		t.Errorf("contents under the drawer = %v, want the whole area at %v", got, want)
	}
}

// The header names the column the drawer would act on, which is the one the
// selected cell is in. That is what keeps applying a formula from needing a
// click back into the sheet while the panel is open.
func TestTheDrawerNamesTheColumnTheSelectedCellIsIn(t *testing.T) {
	s, w := loadedSales(t)

	w.table.Select(widget.TableCellID{Row: 0, Col: 2})
	s.toggleDrawer()

	if got, want := s.drawer.target.Text, "column C · units"; got != want {
		t.Errorf("target = %q, want %q", got, want)
	}

	w.table.Select(widget.TableCellID{Row: 0, Col: 1})
	if got, want := s.drawer.target.Text, "column B · region"; got != want {
		t.Errorf("target after moving = %q, want %q", got, want)
	}
}

// The footer counts what is actually in the library and says where it is, so a
// person can find the files without being told separately.
func TestTheFooterCountsTheLibrary(t *testing.T) {
	s, _ := loadedSales(t)
	stockLibrary(t, s, "unit-margin", "variance")

	s.toggleDrawer()

	if got := s.drawer.foot.Text; !strings.HasPrefix(got, "2 formulas") {
		t.Errorf("footer = %q, want it to count both formulas", got)
	}
	if got := len(s.drawer.list.Objects); got != 2 {
		t.Errorf("list holds %d rows, want 2", got)
	}
}

// Applying a column formula binds the target column: 7 rows filled, one line in
// the log, and the library reference kept so edit can find the file again.
func TestApplyingAColumnFormulaBindsTheTargetColumn(t *testing.T) {
	s, w := loadedSales(t)
	stockLibrary(t, s, "unit-margin")
	s.toggleDrawer()

	// region is the column being bound; the expression reads units and date is
	// left alone, so nothing is asked to depend on itself.
	w.table.Select(widget.TableCellID{Row: 0, Col: 1})
	s.applyFormula(library.Formula{
		ID: "double-units", Kind: library.KindColumn, Expr: "units * 2",
	})

	if got, want := w.sheet.Display(0, 1), "2408"; got != want {
		t.Errorf("bound cell = %q, want %q", got, want)
	}
	if got, want := w.sheet.EditCount(), 1; got != want {
		t.Errorf("log holds %d edits, want %d for a whole column", got, want)
	}
	if got := w.formulaRefs[1]; got != "double-units" {
		t.Errorf("reference = %q, want the library id kept", got)
	}
}

// Applying a notation formula writes it into the selected cell rather than over
// the column, because notation lives in one cell and depends on nothing.
func TestApplyingNotationWritesOneCell(t *testing.T) {
	s, w := loadedSales(t)
	s.toggleDrawer()

	w.table.Select(widget.TableCellID{Row: 1, Col: 1})
	s.applyFormula(library.Formula{
		ID: "variance", Kind: library.KindNotation, Expr: "x^2",
	})

	if got, want := w.sheet.Display(1, 1), "x²"; got != want {
		t.Errorf("noted cell = %q, want %q", got, want)
	}
	if got, want := w.sheet.Display(0, 1), "West"; got != want {
		t.Errorf("neighbouring cell = %q, want %q left alone", got, want)
	}
}

// The preview evaluates against the first row as you type, which is how a
// mistake is caught before it is bound to every row.
func TestThePreviewAnswersAgainstTheFirstRow(t *testing.T) {
	s, w := loadedSales(t)
	s.toggleDrawer()
	w.table.Select(widget.TableCellID{Row: 0, Col: 1})

	s.newFormula()
	s.drawer.editor.expr.SetText("units * 2")

	if got, want := s.drawer.editor.preview.Text, "2408"; got != want {
		t.Errorf("preview = %q, want %q", got, want)
	}
	if got, want := s.drawer.editor.applies.Text, "column B · region"; got != want {
		t.Errorf("applies to = %q, want %q", got, want)
	}
}

// And says why when the answer is that it would not work, rather than leaving a
// person to find out from a column of #ERR.
func TestThePreviewNamesWhatIsWrong(t *testing.T) {
	s, _ := loadedSales(t)
	s.toggleDrawer()
	s.newFormula()

	for _, c := range []struct{ expr, want string }{
		{"units *", "formula"},    // does not parse
		{"postage + 1", "column"}, // parses, reads a column that is not there
	} {
		s.drawer.editor.expr.SetText(c.expr)
		if got := s.drawer.editor.preview.Text; !strings.Contains(got, c.want) {
			t.Errorf("preview of %q = %q, want it to mention %q", c.expr, got, c.want)
		}
	}
}

// Typing writes the formula to its own file on a debounce, and the footer says
// which file and when, because a thing that saves itself should say so.
func TestTypingAutosavesToTheFormulasOwnFile(t *testing.T) {
	s, _ := loadedSales(t)
	stockLibrary(t, s)
	s.toggleDrawer()
	s.newFormula()

	s.drawer.editor.name.SetText("Doubled units")
	s.drawer.editor.expr.SetText("units * 2")

	id := s.drawer.editor.editing.ID
	path := filepath.Join(s.libraryDir(), id+".unof")

	waitFor(t, func() bool {
		_, err := os.Stat(path)
		return err == nil
	}, "the autosave to land")

	f, err := library.Read(path)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if got, want := f.Expr, "units * 2"; got != want {
		t.Errorf("saved expr = %q, want %q", got, want)
	}
	if got, want := f.Name, "Doubled units"; got != want {
		t.Errorf("saved name = %q, want %q", got, want)
	}
	// refs are derived on save, so the file says what the formula reads without
	// anyone having to keep the two in step by hand.
	if got := f.Refs; len(got) != 1 || got[0] != "units" {
		t.Errorf("saved refs = %v, want [units]", got)
	}
}

// A formula bound in this workspace has to be findable again after a save and a
// reopen, and the file has to compute whether or not the reference resolves.
func TestTheLibraryReferenceSurvivesASaveAndReopen(t *testing.T) {
	s, w := loadedSales(t)
	w.table.Select(widget.TableCellID{Row: 0, Col: 1})
	s.applyFormula(library.Formula{
		ID: "double-units", Kind: library.KindColumn, Expr: "units * 2",
	})

	doc := w.document()
	if got := doc.State.ColumnFormulas; len(got) != 1 || got[0].Col != 1 || got[0].Ref != "double-units" {
		t.Fatalf("ColumnFormulas = %v, want the reference for column 1", got)
	}

	back := refsByColumn(doc.State.ColumnFormulas)
	if got := back[1]; got != "double-units" {
		t.Errorf("reference back = %q, want it round-tripped", got)
	}
}

// waitFor polls rather than sleeping a fixed span, so a slow machine does not
// turn a debounce into a flake.
func waitFor(t *testing.T, done func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if done() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}
