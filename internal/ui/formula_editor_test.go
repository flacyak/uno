package ui

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/flacyak/uno/internal/library"
)

// bytesOf reads a .unof the way anyone else's tool would, so a test can say a
// file was left exactly as it was found rather than merely still parsing.
func bytesOf(t *testing.T, dir, id string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, id+".unof"))
	if err != nil {
		t.Fatalf("read %s: %v", id, err)
	}
	return b
}

// besideOne opens the editor on the one formula lying beside the document, the
// way clicking edit on that row does.
func besideOne(t *testing.T, s *Shell) sourced {
	t.Helper()
	beside, _, err := s.sources()
	if err != nil {
		t.Fatalf("sources: %v", err)
	}
	if len(beside) != 1 {
		t.Fatalf("beside the document = %d formulas, want 1", len(beside))
	}
	return beside[0]
}

// edit beside a name opens that file, the actual one, wherever it lives, and
// that is the sentence the whole format rests on. Typing into a formula that
// arrived beside the document rewrites the file in that folder, and the copy in
// the person's own library is not touched even when it goes by the same id.
func TestEditingAFormulaBesideTheDocumentWritesItBackToThatFolder(t *testing.T) {
	s, _, dir := besideSales(t, "unit-margin")
	stockLibrary(t, s, "unit-margin")
	mine := bytesOf(t, s.libraryDir(), "unit-margin")

	s.toggleDrawer()
	s.editFormula(besideOne(t, s))
	s.drawer.editor.expr.SetText("units * 5")

	waitFor(t, func() bool {
		f, err := library.Read(filepath.Join(dir, "unit-margin.unof"))
		return err == nil && f.Expr == "units * 5"
	}, "the file beside the document to be rewritten")

	if got := bytesOf(t, s.libraryDir(), "unit-margin"); !bytes.Equal(got, mine) {
		t.Errorf("the library copy = %s, want it byte-identical at %s", got, mine)
	}
}

// A formula written here is not beside anything: it arrived with no document and
// nobody sent it, so it belongs in the library. Writing it into whichever folder
// happened to be open would scatter one person's own formulas across every
// folder they ever had a file in, and leave the library they can find empty.
func TestANewFormulaIsWrittenToYourLibraryAndNotBesideTheDocument(t *testing.T) {
	s, _, dir := besideSales(t)
	stockLibrary(t, s)

	s.toggleDrawer()
	s.newFormula()
	s.drawer.editor.name.SetText("Doubled units")
	s.drawer.editor.expr.SetText("units * 2")

	id := s.drawer.editor.editing.ID
	waitFor(t, func() bool {
		_, err := os.Stat(filepath.Join(s.libraryDir(), id+".unof"))
		return err == nil
	}, "the new formula to land in the library")

	if _, err := os.Stat(filepath.Join(dir, id+".unof")); !os.IsNotExist(err) {
		t.Errorf("%s.unof beside the document = %v, want it only in the library", id, err)
	}
}

// The autosave rewrites a file that may have arrived in an email or be tracked
// in somebody's git repository, and nothing asks first. What is owed instead is
// that the footer says which of the two places the file is, so the answer is on
// screen before the first keystroke rather than discovered after it.
func TestTheEditorSaysAFormulaBesideTheDocumentIsBesideTheFile(t *testing.T) {
	s, _, _ := besideSales(t, "unit-margin")
	stockLibrary(t, s)

	s.toggleDrawer()
	s.editFormula(besideOne(t, s))

	if got, want := s.drawer.editor.foot.Text, "· unit-margin.unof · beside file"; got != want {
		t.Errorf("footer = %q, want %q", got, want)
	}
}

// And says the other thing about the other folder. "This one is yours" is the
// reassurance the beside case cannot be given, so it has to be said out loud in
// the case where it is true rather than left as the absence of a warning.
func TestTheEditorSaysAFormulaFromTheLibraryIsYourOwn(t *testing.T) {
	s, _ := loadedSales(t)
	stockLibrary(t, s, "variance")

	s.toggleDrawer()
	_, lib, err := s.sources()
	if err != nil {
		t.Fatalf("sources: %v", err)
	}
	if len(lib) != 1 {
		t.Fatalf("in the library = %d formulas, want 1", len(lib))
	}
	s.editFormula(lib[0])

	if got, want := s.drawer.editor.foot.Text, "· variance.unof · your library"; got != want {
		t.Errorf("footer = %q, want %q", got, want)
	}
}

// Opening a formula is reading it, and reading a file is not a reason to write
// one. Every field the editor fills fires the same OnChanged a keystroke does,
// so without a guard, clicking edit and going straight back out rewrites the
// file and moves its modified date. For a formula that arrived beside the
// document that is somebody else's file, changed by somebody who only looked.
func TestOpeningAFormulaWithoutTypingLeavesItsFileAlone(t *testing.T) {
	s, _, dir := besideSales(t, "unit-margin")
	stockLibrary(t, s)
	untouched := bytesOf(t, dir, "unit-margin")

	s.toggleDrawer()
	s.editFormula(besideOne(t, s))

	// No timer is the claim, and asserting it here is what makes the claim
	// deterministic rather than a race against the debounce: there is nothing
	// pending to wait out, and leaveEditor's flush returns early on exactly
	// this.
	if s.drawer.editor.timer != nil {
		t.Error("opening a formula scheduled a write, want none until a key is pressed")
	}
	s.leaveEditor()

	if got := bytesOf(t, dir, "unit-margin"); !bytes.Equal(got, untouched) {
		t.Errorf("the file = %s, want it byte-identical at %s", got, untouched)
	}
}
