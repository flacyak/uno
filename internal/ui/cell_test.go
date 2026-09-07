package ui

import (
	"strings"
	"testing"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/widget"
)

// tap is a click on a square of the grid, which is all a cell widget does with
// one. Driving the shell here rather than synthesising a pointer event is the
// same level undo_test.go tests the editor bar at.
func tap(w *workspace, s *Shell, row, col int) {
	s.tapCell(w, widget.TableCellID{Row: row, Col: col})
}

// typeIn and enter are the two halves of typing into an open cell editor: the
// editor is handed whatever is in the field, so a test that skips the first half
// is testing a retype.
//
// Both of these and escape go through TypedKey rather than calling the callback
// underneath, because which widget answers a key is now part of what is being
// tested: press sends the same key to the grid instead.
func typeIn(w *workspace, text string) { w.inline.SetText(text) }
func enter(w *workspace)               { w.inline.TypedKey(&fyne.KeyEvent{Name: fyne.KeyReturn}) }

func escape(w *workspace) {
	w.inline.TypedKey(&fyne.KeyEvent{Name: fyne.KeyEscape})
}

// press is a key struck with the grid focused, which is where Enter opens a cell
// and the arrows move between them.
func press(w *workspace, k fyne.KeyName) { w.table.TypedKey(&fyne.KeyEvent{Name: k}) }

// The first click on a cell does what a click has always done: it chooses the
// cell and points the editor bar at it, and nothing opens in the grid.
func TestClickingACellChoosesItAndOpensNothing(t *testing.T) {
	s, w := loaded(t)

	tap(w, s, 1, 2)

	if w.editing {
		t.Error("one click opened the cell for editing")
	}
	if w.active.Row != 1 || w.active.Col != 2 {
		t.Errorf("active = %v, want the clicked cell", w.active)
	}
	if got := w.editor.Text; got != "987" {
		t.Errorf("editor bar = %q, want the clicked cell's value", got)
	}
}

// Clicking the cell that is already chosen opens it, carrying what is in it so a
// correction is not a retype.
func TestClickingTheChosenCellOpensItOnItsValue(t *testing.T) {
	s, w := loaded(t)

	tap(w, s, 0, 2)
	tap(w, s, 0, 2)

	if !w.editing {
		t.Fatal("a second click on the chosen cell did not open it")
	}
	if got := w.inline.Text; got != "1,204" {
		t.Errorf("inline editor = %q, want the value already in the cell", got)
	}
}

// Enter in the grid writes through the same commit the editor bar uses, so the
// change is logged, the badge follows it, and the bar reads the new value.
func TestEnterInTheGridCommitsTheEdit(t *testing.T) {
	s, w := loaded(t)

	tap(w, s, 0, 2)
	tap(w, s, 0, 2)
	typeIn(w, "1204")
	enter(w)

	if w.editing {
		t.Error("the editor stayed open after Enter")
	}
	if got := w.sheet.Raw(0, 2); got != "1204" {
		t.Errorf("cell = %q, want the typed value", got)
	}
	if w.sheet.EditCount() != 1 {
		t.Errorf("log = %d entries, want the edit recorded once", w.sheet.EditCount())
	}
	if got := w.editor.Text; got != "1204" {
		t.Errorf("editor bar = %q, want it following the grid", got)
	}
	if c := w.sheet.Columns[2]; c.Kind.String() != "num" || c.Flagged {
		t.Errorf("units = %v flagged=%v, want the badge fixed", c.Kind, c.Flagged)
	}
}

// Escape is the way out of an editor opened by a stray click: nothing is written
// and nothing is logged.
func TestEscapeInTheGridWritesNothing(t *testing.T) {
	s, w := loaded(t)

	tap(w, s, 0, 2)
	tap(w, s, 0, 2)
	typeIn(w, "nonsense")
	escape(w)

	if w.editing {
		t.Error("Escape left the editor open")
	}
	if got := w.sheet.Raw(0, 2); got != "1,204" {
		t.Errorf("cell = %q, want it untouched", got)
	}
	if w.sheet.EditCount() != 0 {
		t.Errorf("log = %d entries, want nothing recorded", w.sheet.EditCount())
	}
	if w.dirty() {
		t.Error("a cancelled edit marked the workspace dirty")
	}
}

// Clicking away keeps what was typed, the way a spreadsheet does, and lands on
// the cell that was clicked.
func TestClickingAnotherCellKeepsWhatWasTyped(t *testing.T) {
	s, w := loaded(t)

	tap(w, s, 0, 2)
	tap(w, s, 0, 2)
	typeIn(w, "1204")
	tap(w, s, 1, 2)

	if w.editing {
		t.Error("the editor followed the click to the next cell")
	}
	if got := w.sheet.Raw(0, 2); got != "1204" {
		t.Errorf("cell = %q, want the typed value kept", got)
	}
	if w.active.Row != 1 || w.active.Col != 2 {
		t.Errorf("active = %v, want the newly clicked cell", w.active)
	}
	if got := w.editor.Text; got != "987" {
		t.Errorf("editor bar = %q, want the newly clicked cell's value", got)
	}
}

// Retyping the value that is already there is not an edit, however it was typed.
func TestRetypingTheSameValueInTheGridLogsNothing(t *testing.T) {
	s, w := loaded(t)

	tap(w, s, 0, 2)
	tap(w, s, 0, 2)
	typeIn(w, "1,204")
	enter(w)

	if w.sheet.EditCount() != 0 {
		t.Errorf("log = %d entries, want a retype to count for nothing", w.sheet.EditCount())
	}
}

// Undo rebuilds the sheet from the raw bytes, so an editor left open over it has
// to go — with whatever was in it, which was never committed.
func TestUndoClosesAnOpenCellEditor(t *testing.T) {
	s, w := loaded(t)

	tap(w, s, 0, 2)
	tap(w, s, 0, 2)
	typeIn(w, "1204")
	enter(w)

	tap(w, s, 0, 2)
	typeIn(w, "junk")
	s.undo()

	if w.editing {
		t.Error("undo left the cell editor open")
	}
	if got := w.sheet.Raw(0, 2); got != "1,204" {
		t.Errorf("cell = %q, want the raw value back and nothing typed over it", got)
	}
	if w.sheet.EditCount() != 0 {
		t.Errorf("log = %d entries, want it empty", w.sheet.EditCount())
	}
}

// The editor is one widget moved between squares, so a square shows it only
// while it is the cell being edited, and every other square shows its label.
func TestOnlyTheEditedCellHoldsTheEditor(t *testing.T) {
	s, w := loaded(t)

	tap(w, s, 0, 2)
	tap(w, s, 0, 2)

	here, there := s.newCell(w), s.newCell(w)
	here.show(widget.TableCellID{Row: 0, Col: 2})
	there.show(widget.TableCellID{Row: 1, Col: 2})

	if here.box.Objects[0] != fyne.CanvasObject(w.inline) {
		t.Error("the cell being edited is not showing the editor")
	}
	if there.box.Objects[0] != fyne.CanvasObject(there.label) {
		t.Error("a cell that is not being edited is showing the editor")
	}
	if got := there.label.Text; got != "987" {
		t.Errorf("cell label = %q, want its own value", got)
	}

	// Moving it on leaves the square it came from showing its label again,
	// which is what stops one entry being parented in two places.
	again := s.newCell(w)
	again.show(widget.TableCellID{Row: 0, Col: 2})

	if here.box.Objects[0] != fyne.CanvasObject(here.label) {
		t.Error("the square the editor moved off is still holding it")
	}
	if again.box.Objects[0] != fyne.CanvasObject(w.inline) {
		t.Error("the square the editor moved to is not holding it")
	}
}

// The same thing again, but through the real grid: the table builds and recycles
// the squares itself, so this is what proves the cell template is wired to the
// editor rather than only that the swap logic is right.
func TestTheRenderedGridPutsTheEditorInTheCell(t *testing.T) {
	s, w := loaded(t)
	s.win.Resize(fyne.NewSize(800, 600)) // lay the grid out, so cells are built

	tap(w, s, 0, 2)
	tap(w, s, 0, 2)

	if w.inlineIn == nil {
		t.Fatal("no square in the rendered grid took the editor")
	}
	if got := w.inlineIn.id; got.Row != 0 || got.Col != 2 {
		t.Errorf("editor sits in %v, want the cell being edited", got)
	}

	escape(w)

	if w.inlineIn != nil {
		t.Errorf("a closed editor is still parented in %v", w.inlineIn.id)
	}
}

// A square that handles its own click is a square widget.Table never sees the
// click on, and with it never does the focusing it does for itself. Without that
// focusing done by hand the grid would quietly stop answering the keyboard, so
// this is the regression the manual call exists to prevent.
func TestTheKeyboardFollowsWhatIsBeingWorkedOn(t *testing.T) {
	s, w := loaded(t)

	tap(w, s, 1, 2)
	if got := s.win.Canvas().Focused(); got != fyne.Focusable(w.table) {
		t.Errorf("focus = %T, want the grid after a plain click", got)
	}

	tap(w, s, 1, 2)
	if got := s.win.Canvas().Focused(); got != fyne.Focusable(w.inline) {
		t.Errorf("focus = %T, want the cell editor once it is open", got)
	}

	escape(w)
	if got := s.win.Canvas().Focused(); got != fyne.Focusable(w.table) {
		t.Errorf("focus = %T, want the grid back when the editor closes", got)
	}
}

// Enter is the keyboard's way into a cell, and it has to reach exactly what a
// second click reaches: the chosen cell, open on the value already in it.
func TestEnterInTheGridOpensTheChosenCell(t *testing.T) {
	s, w := loaded(t)

	tap(w, s, 0, 2)
	press(w, fyne.KeyReturn)

	if !w.editing {
		t.Fatal("Enter on the chosen cell did not open it")
	}
	if got := w.inline.Text; got != "1,204" {
		t.Errorf("inline editor = %q, want the value already in the cell", got)
	}
	if got := s.win.Canvas().Focused(); got != fyne.Focusable(w.inline) {
		t.Errorf("focus = %T, want the cell editor Enter opened", got)
	}
}

// Enter opens the cell and Enter closes it again, so the whole edit is one key
// struck twice with the value typed in between.
func TestEnterOpensAndEnterCommits(t *testing.T) {
	s, w := loaded(t)

	tap(w, s, 0, 2)
	press(w, fyne.KeyReturn)
	typeIn(w, "1204")
	enter(w)

	if w.editing {
		t.Error("the editor stayed open after the second Enter")
	}
	if got := w.sheet.Raw(0, 2); got != "1204" {
		t.Errorf("cell = %q, want the typed value", got)
	}
	if got := s.win.Canvas().Focused(); got != fyne.Focusable(w.table) {
		t.Errorf("focus = %T, want the grid back once the editor closed", got)
	}
}

// A file with a header and no rows has no cell to open, and Enter on it must do
// nothing rather than reach past the end of the sheet.
func TestEnterOnASheetWithNoRowsOpensNothing(t *testing.T) {
	s := newTestShell(t)
	if err := s.load("empty.csv", strings.NewReader("date,region,units\n")); err != nil {
		t.Fatalf("load: %v", err)
	}
	w := s.active()

	press(w, fyne.KeyReturn)

	if w.editing {
		t.Error("Enter opened an editor on a sheet with no rows")
	}
}

// The arrows move where you are, not just a rectangle: active, the editor bar
// and the cell reference are one idea of it, and Enter opens the cell they name.
func TestArrowKeysMoveTheChosenCell(t *testing.T) {
	s, w := loaded(t)
	s.win.Resize(fyne.NewSize(800, 600)) // lay the grid out, so the table can scroll

	tap(w, s, 0, 2)
	press(w, fyne.KeyDown)

	if w.active.Row != 1 || w.active.Col != 2 {
		t.Fatalf("active = %v, want the cell below the one clicked", w.active)
	}
	if got := w.editor.Text; got != "987" {
		t.Errorf("editor bar = %q, want it following the arrows", got)
	}
	if got := s.cell.Text; got != "C2" {
		t.Errorf("cell reference = %q, want C2", got)
	}

	press(w, fyne.KeyReturn)

	if got := w.inline.Text; got != "987" {
		t.Errorf("inline editor = %q, want the cell arrowed to, not the one clicked", got)
	}
}
