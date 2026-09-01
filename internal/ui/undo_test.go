package ui

import (
	"path/filepath"
	"strings"
	"testing"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/widget"

	"github.com/flacyak/uno/internal/document"
)

// edit types a value into a cell the way the editor bar does.
func edit(t *testing.T, w *workspace, row, col int, value string) {
	t.Helper()
	w.table.Select(widget.TableCellID{Row: row, Col: col})
	w.editor.OnSubmitted(value)
}

// Undo takes the last change back, drops it from the log, and leaves everything
// before it in place.
func TestUndoStepsBackOneEditAtATime(t *testing.T) {
	s, w := loaded(t)

	edit(t, w, 0, 2, "1204")
	edit(t, w, 1, 2, "986")

	s.undo()

	if got := w.sheet.At(1, 2); got != "987" {
		t.Errorf("cell = %q, want the original %q back", got, "987")
	}
	if got := w.sheet.At(0, 2); got != "1204" {
		t.Errorf("the earlier edit = %q, want it left alone", got)
	}
	if w.sheet.EditCount() != 1 {
		t.Errorf("log = %d entries, want the undone one dropped", w.sheet.EditCount())
	}

	s.undo()

	if got := w.sheet.At(0, 2); got != "1,204" {
		t.Errorf("cell = %q, want the raw value back", got)
	}
	if w.sheet.EditCount() != 0 {
		t.Errorf("log = %d entries, want it empty", w.sheet.EditCount())
	}
}

// Undoing past the beginning does nothing at all, however many times it is asked.
func TestUndoWithNothingToUndoDoesNothing(t *testing.T) {
	s, w := loaded(t)

	s.undo()
	s.undo()

	if w.dirty() {
		t.Error("undo on an untouched workspace marked it dirty")
	}
	if got := w.sheet.At(0, 2); got != "1,204" {
		t.Errorf("cell = %q, want the file untouched", got)
	}
}

// The grid and the editor read the rebuilt sheet, and the badge follows the
// values back: fixing every unparseable value makes a column numeric, and taking
// one of those fixes back makes it text again.
func TestUndoIsVisibleInTheGridAndTheBadge(t *testing.T) {
	s, w := loaded(t)

	edit(t, w, 0, 2, "1204")
	if c := w.sheet.Columns[2]; c.Kind.String() != "num" || c.Flagged {
		t.Fatalf("units = %v flagged=%v, want num once every value parses",
			c.Kind, c.Flagged)
	}

	s.undo()

	if c := w.sheet.Columns[2]; c.Kind.String() != "text" || !c.Flagged {
		t.Errorf("units = %v flagged=%v, want the warning badge back", c.Kind, c.Flagged)
	}
	if got := w.editor.Text; got != "1,204" {
		t.Errorf("editor = %q, want the restored value", got)
	}
	if got := s.status.Text; strings.Contains(got, "edit") {
		t.Errorf("status = %q, want no edits reported", got)
	}
}

// Undo is not a memory of this session: it is the log and the raw bytes, both of
// which travel in the file, so a workspace reopened from disk still steps back
// through edits made before it was saved.
func TestUndoWorksOnAReopenedFile(t *testing.T) {
	_, w := loaded(t)
	edit(t, w, 0, 2, "1204")
	edit(t, w, 1, 2, "986")

	path := filepath.Join(t.TempDir(), "sales.uno")
	if err := document.Write(path, w.document()); err != nil {
		t.Fatalf("Write: %v", err)
	}

	fresh := newTestShell(t)
	if err := fresh.openURI(fileURI(t, path)); err != nil {
		t.Fatalf("open: %v", err)
	}
	reopened := fresh.active()

	fresh.undo()

	if got := reopened.sheet.At(1, 2); got != "987" {
		t.Errorf("cell = %q, want an edit made before the save taken back", got)
	}
	if got := reopened.sheet.At(0, 2); got != "1204" {
		t.Errorf("the earlier edit = %q, want it left alone", got)
	}
	if !reopened.dirty() {
		t.Error("undoing past what the file holds left the workspace clean")
	}
}

// Undoing back to what was saved is not a change, so the dot clears again.
func TestUndoBackToTheSavedStateClearsTheDot(t *testing.T) {
	s, w := loaded(t)
	edit(t, w, 0, 2, "1204")

	path := filepath.Join(t.TempDir(), "sales.uno")
	doc := w.document()
	if err := document.Write(path, doc); err != nil {
		t.Fatalf("Write: %v", err)
	}
	s.wrote(w, path, doc, nil)

	edit(t, w, 1, 2, "986")
	if !w.dirty() {
		t.Fatal("an edit after a save did not mark the workspace dirty")
	}

	s.undo()

	if w.dirty() {
		t.Error("undoing back to the saved state left the dot on")
	}
	if got := s.tabs.Items[0].Text; got != "sales.uno" {
		t.Errorf("tab = %q, want no dirty marker", got)
	}
}

// Ctrl+Z has to be the framework's own undo shortcut: the driver matches the
// main menu by shortcut name before the focused widget sees the key, and a
// custom Ctrl+Z would lose to the editor bar's own text undo.
func TestUndoIsOnTheEditMenuUnderTheStandardShortcut(t *testing.T) {
	s := newTestShell(t)

	var edit *fyne.Menu
	for _, m := range s.win.MainMenu().Items {
		if m.Label == "Edit" {
			edit = m
		}
	}
	if edit == nil {
		t.Fatal("no Edit menu")
	}
	if len(edit.Items) == 0 || edit.Items[0].Label != "Undo" {
		t.Fatalf("Edit menu = %v, want Undo in it", edit.Items)
	}

	sc := edit.Items[0].Shortcut
	if _, ok := sc.(*fyne.ShortcutUndo); !ok {
		t.Fatalf("shortcut = %T, want *fyne.ShortcutUndo", sc)
	}
	ks, ok := sc.(fyne.KeyboardShortcut)
	if !ok {
		t.Fatal("the undo shortcut does not describe a key")
	}
	if ks.Key() != fyne.KeyZ || ks.Mod() != fyne.KeyModifierShortcutDefault {
		t.Errorf("shortcut = %v+%v, want the platform default + Z", ks.Mod(), ks.Key())
	}
}

// The item greys out when there is nothing behind the workspace to step back to.
func TestTheUndoItemFollowsWhetherThereIsAnythingToUndo(t *testing.T) {
	s, w := loaded(t)

	if !s.undoIt.Disabled {
		t.Error("Undo is offered on a workspace nothing has been done to")
	}

	edit(t, w, 0, 2, "1204")
	if s.undoIt.Disabled {
		t.Error("Undo is greyed out after an edit")
	}

	s.undo()
	if !s.undoIt.Disabled {
		t.Error("Undo is still offered with an empty log")
	}
}

// Undoing and then typing something else lands on the same number of edits and a
// different sheet, so the workspace has to stay dirty. This is the case a count
// of edits gets wrong.
func TestUndoThenADifferentEditStaysDirty(t *testing.T) {
	s, w := loaded(t)
	edit(t, w, 0, 2, "1204")

	path := filepath.Join(t.TempDir(), "sales.uno")
	doc := w.document()
	if err := document.Write(path, doc); err != nil {
		t.Fatalf("Write: %v", err)
	}
	s.wrote(w, path, doc, nil)

	s.undo()
	edit(t, w, 0, 2, "1205") // same cell, one edit again, different value

	if w.sheet.EditCount() != 1 {
		t.Fatalf("log = %d entries, want the same count the file has", w.sheet.EditCount())
	}
	if !w.dirty() {
		t.Error("a workspace holding a different edit than the file reads as saved")
	}
}
