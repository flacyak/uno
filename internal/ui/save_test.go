package ui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/driver/desktop"
	"fyne.io/fyne/v2/widget"

	"github.com/flacyak/uno/internal/document"
)

// loaded returns a shell with one CSV-backed workspace and a cell selected.
func loaded(t *testing.T) (*Shell, *workspace) {
	t.Helper()

	s := newTestShell(t)
	if err := s.load("sales.csv", strings.NewReader(csvBody)); err != nil {
		t.Fatalf("load: %v", err)
	}
	return s, s.active()
}

// Typing into the editor bar changes the cell and writes a line to the log, in
// one step: there is no way to change data without recording that it changed.
func TestEditingACellLogsItAndMarksTheTabDirty(t *testing.T) {
	s, w := loaded(t)

	w.table.Select(widget.TableCellID{Row: 0, Col: 2})
	if got := w.editor.Text; got != "1,204" {
		t.Fatalf("editor = %q, want the selected cell's value", got)
	}

	w.editor.OnSubmitted("1204")

	if got := w.sheet.Raw(0, 2); got != "1204" {
		t.Errorf("cell = %q, want %q", got, "1204")
	}
	if w.sheet.EditCount() != 1 {
		t.Errorf("edits = %d, want 1", w.sheet.EditCount())
	}
	if !w.dirty() {
		t.Error("the workspace is not marked dirty")
	}
	if got := s.tabs.Items[0].Text; got != "sales.csv •" {
		t.Errorf("tab = %q, want the dirty marker", got)
	}
	if !strings.Contains(s.status.Text, "1 edit") ||
		!strings.Contains(s.status.Text, "unsaved") {
		t.Errorf("status = %q, want it to report one unsaved edit", s.status.Text)
	}
}

// Retyping what is already in a cell is not a change and must not grow the log.
func TestRetypingTheSameValueIsNotAnEdit(t *testing.T) {
	_, w := loaded(t)

	w.table.Select(widget.TableCellID{Row: 0, Col: 2})
	w.editor.OnSubmitted("1,204")

	if w.sheet.EditCount() != 0 {
		t.Errorf("edits = %d, want none", w.sheet.EditCount())
	}
	if w.dirty() {
		t.Error("the workspace was marked dirty by a change that did not happen")
	}
}

// The selected cell is named the way a spreadsheet names it, and it is the state
// a save carries so reopening lands where you left off.
func TestSelectingACellNamesItAndIsSaved(t *testing.T) {
	s, w := loaded(t)

	w.table.Select(widget.TableCellID{Row: 1, Col: 2})
	if got := s.cell.Text; got != "C2" {
		t.Errorf("cell reference = %q, want C2", got)
	}
	if got := w.document().State.Active; got != (document.Cell{Row: 1, Col: 2}) {
		t.Errorf("saved active cell = %+v, want row 1 col 2", got)
	}
}

func TestColNameCountsLikeASpreadsheet(t *testing.T) {
	for _, c := range []struct {
		col  int
		want string
	}{{0, "A"}, {25, "Z"}, {26, "AA"}, {27, "AB"}, {51, "AZ"}, {52, "BA"}, {701, "ZZ"}, {702, "AAA"}} {
		if got := colName(c.col); got != c.want {
			t.Errorf("colName(%d) = %q, want %q", c.col, got, c.want)
		}
	}
}

// Ctrl+S on a workspace with no .uno behind it is the same intent as Save As, so
// it asks rather than doing nothing.
func TestSaveFallsThroughToSaveAsOnAFirstSave(t *testing.T) {
	s, w := loaded(t)
	if w.path != "" {
		t.Fatal("a CSV-backed workspace should have no .uno behind it")
	}

	s.save()

	if s.win.Canvas().Overlays().Top() == nil {
		t.Fatal("Save raised no dialog on a workspace that has never been saved")
	}
	if w.dirty() {
		t.Error("raising the dialog changed the workspace")
	}
}

// Save and Save As are both on the menu and both reachable from the keyboard,
// and Save As is the shifted one.
func TestSaveIsReachableFromTheMenuAndAShortcut(t *testing.T) {
	s := newTestShell(t)

	items := map[string]*fyne.MenuItem{}
	for _, it := range s.win.MainMenu().Items[0].Items {
		items[it.Label] = it
	}

	for _, c := range []struct {
		label string
		mod   fyne.KeyModifier
	}{
		{"Save", fyne.KeyModifierShortcutDefault},
		{"Save As…", fyne.KeyModifierShortcutDefault | fyne.KeyModifierShift},
	} {
		it, ok := items[c.label]
		if !ok {
			t.Errorf("no %q item in the File menu", c.label)
			continue
		}
		sc, ok := it.Shortcut.(*desktop.CustomShortcut)
		if !ok {
			t.Errorf("%s shortcut = %T, want *desktop.CustomShortcut", c.label, it.Shortcut)
			continue
		}
		if sc.KeyName != fyne.KeyS || sc.Modifier != c.mod {
			t.Errorf("%s shortcut = %v+%v, want %v+S", c.label, sc.Modifier, sc.KeyName, c.mod)
		}
	}
}

// A finished save takes the .uno's name, clears the dot, and keeps naming the
// file the data came from.
func TestAFinishedSaveClearsTheDot(t *testing.T) {
	s, w := loaded(t)
	w.table.Select(widget.TableCellID{Row: 0, Col: 2})
	w.editor.OnSubmitted("1204")

	path := filepath.Join(t.TempDir(), "sales.uno")
	doc := w.document()
	if err := document.Write(path, doc); err != nil {
		t.Fatalf("Write: %v", err)
	}
	s.wrote(w, path, doc, nil)

	if w.dirty() {
		t.Error("the dot did not clear")
	}
	if got := s.tabs.Items[0].Text; got != "sales.uno" {
		t.Errorf("tab = %q, want the .uno name with no dot", got)
	}
	if !strings.Contains(s.status.Text, "saved") ||
		!strings.Contains(s.status.Text, "from sales.csv") {
		t.Errorf("status = %q, want it saved and still naming the source", s.status.Text)
	}
	if w.manifest.Created.IsZero() {
		t.Error("the workspace did not take the manifest the writer measured")
	}
}

// A save writes the snapshot it was given. Anything typed while the file was
// being written is not in it, so the workspace stays dirty.
func TestEditingDuringASaveLeavesTheWorkspaceDirty(t *testing.T) {
	s, w := loaded(t)
	w.table.Select(widget.TableCellID{Row: 0, Col: 2})
	w.editor.OnSubmitted("1204")

	doc := w.document() // what the worker took away

	w.table.Select(widget.TableCellID{Row: 1, Col: 2})
	w.editor.OnSubmitted("986") // typed while the file was being written

	s.wrote(w, filepath.Join(t.TempDir(), "sales.uno"), doc, nil)

	if !w.dirty() {
		t.Error("the dot cleared for an edit the saved file does not contain")
	}
}

// Reopening restores the grid, the provenance and the place you were, without
// the CSV being anywhere on the machine.
func TestOpeningAUnoRestoresTheWorkspace(t *testing.T) {
	_, w := loaded(t)
	w.table.Select(widget.TableCellID{Row: 0, Col: 2})
	w.editor.OnSubmitted("1204")

	path := filepath.Join(t.TempDir(), "sales.uno")
	if err := document.Write(path, w.document()); err != nil {
		t.Fatalf("Write: %v", err)
	}

	fresh := newTestShell(t)
	if err := fresh.openURI(fileURI(t, path)); err != nil {
		t.Fatalf("open the .uno: %v", err)
	}

	got := fresh.active()
	if got.sheet == nil {
		t.Fatal("the .uno opened with no sheet")
	}
	if v := got.sheet.Raw(0, 2); v != "1204" {
		t.Errorf("cell = %q, want the edit replayed", v)
	}
	if got.path != path {
		t.Errorf("path = %q, want the .uno it came from", got.path)
	}
	if got.dirty() {
		t.Error("a freshly opened file is not dirty")
	}
	if name := fresh.tabs.Selected().Text; name != "sales.uno" {
		t.Errorf("tab = %q, want sales.uno", name)
	}
	if got.manifest.Source.Name != "sales.csv" {
		t.Errorf("provenance = %q, want sales.csv", got.manifest.Source.Name)
	}
	if fresh.cell.Text != "C1" {
		t.Errorf("cell reference = %q, want the saved C1", fresh.cell.Text)
	}
}

// A .uno that will not open must leave the workspace as it was, and say why.
func TestAnUnreadableUnoIsReportedAndChangesNothing(t *testing.T) {
	s := newTestShell(t)

	path := filepath.Join(t.TempDir(), "broken.uno")
	if err := os.WriteFile(path, []byte("not a zip"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	err := s.openURI(fileURI(t, path))
	if err == nil {
		t.Fatal("want an error, got nil")
	}
	if !strings.Contains(err.Error(), "broken.uno") {
		t.Errorf("error = %q, want it to name the file", err)
	}
	if got := tabNames(s); len(got) != 1 || got[0] != "Untitled 1" {
		t.Errorf("tabs = %v, want the workspace untouched", got)
	}
}

func TestUnoNameSwapsTheExtension(t *testing.T) {
	for in, want := range map[string]string{
		"sales-q3.csv":  "sales-q3.uno",
		"inventory.tsv": "inventory.uno",
		"sales-q3.uno":  "sales-q3.uno",
		"Untitled 1":    "Untitled 1.uno",
	} {
		if got := unoName(in); got != want {
			t.Errorf("unoName(%q) = %q, want %q", in, got, want)
		}
	}
}
