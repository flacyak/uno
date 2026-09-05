package ui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/flacyak/uno/internal/document"
	"github.com/flacyak/uno/internal/library"
)

// copyFixtures puts the named testdata/*.unof into dir.
func copyFixtures(t *testing.T, dir string, ids ...string) {
	t.Helper()

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

// besideSales gives a shell whose document is a real .uno on disk, so the
// workspace has a path and therefore a folder to read formulas out of. It
// returns the folder the document is sitting in.
func besideSales(t *testing.T, ids ...string) (*Shell, *workspace, string) {
	t.Helper()

	s, w := loadedSales(t)

	dir := t.TempDir()
	path := filepath.Join(dir, "sales-q3.uno")
	doc := w.document()
	if err := document.Write(path, doc); err != nil {
		t.Fatalf("Write: %v", err)
	}
	// Landed the way a finished save lands, rather than by writing w.path by
	// hand, so what the test is standing on is the path a person's save takes.
	s.wrote(w, path, doc, nil)

	copyFixtures(t, dir, ids...)
	return s, w, dir
}

// loadInto is the read the drawer does, said once so a test can spend its lines
// on what came back rather than on getting it.
func loadInto(t *testing.T, dir string) []library.Formula {
	t.Helper()
	found, err := library.Load(dir)
	if err != nil {
		t.Fatalf("Load(%s): %v", dir, err)
	}
	return found
}

func idsOf(found []sourced) []string {
	out := make([]string, 0, len(found))
	for _, f := range found {
		out = append(out, f.ID)
	}
	return out
}

// The whole argument for one file per formula is that sending someone a formula
// is sending them a file. That only pays off if a file lying beside the document
// counts as much as one in the library, so both folders are read and each row
// remembers which of the two it came out of.
func TestAFormulaBesideTheDocumentAndOneInTheLibraryAreBothListed(t *testing.T) {
	beside, lib := t.TempDir(), t.TempDir()
	copyFixtures(t, beside, "unit-margin")
	copyFixtures(t, lib, "std-deviation")

	b, l := split(loadInto(t, beside), loadInto(t, lib), beside, lib)

	if got, want := idsOf(b), []string{"unit-margin"}; !equalNames(got, want) {
		t.Errorf("beside the document = %v, want %v", got, want)
	}
	if got, want := idsOf(l), []string{"std-deviation"}; !equalNames(got, want) {
		t.Errorf("in the library = %v, want %v", got, want)
	}
	if len(b) == 1 && b[0].dir != beside {
		t.Errorf("beside formula's folder = %q, want %q", b[0].dir, beside)
	}
	if len(l) == 1 && l[0].dir != lib {
		t.Errorf("library formula's folder = %q, want %q", l[0].dir, lib)
	}
}

// Someone can be sent a formula whose id they already use, and the drawer has to
// pick one: a person applying a row has to get the expression that row shows,
// and a saved .uno refers to a formula by its bare id, so two rows under one id
// would make that reference ambiguous. The file in front of you wins, because
// that is the one the document you opened was talking about.
func TestTheSameIdInBothFoldersIsListedOnceFromTheFolderTheDocumentIsIn(t *testing.T) {
	beside, lib := t.TempDir(), t.TempDir()
	copyFixtures(t, lib, "unit-margin", "variance")
	if err := library.Save(beside, library.Formula{
		ID: "unit-margin", Name: "Unit margin", Kind: library.KindColumn, Expr: "units * 3",
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	b, l := split(loadInto(t, beside), loadInto(t, lib), beside, lib)

	if got, want := idsOf(b), []string{"unit-margin"}; !equalNames(got, want) {
		t.Errorf("beside the document = %v, want %v", got, want)
	}
	if got, want := idsOf(l), []string{"variance"}; !equalNames(got, want) {
		t.Errorf("in the library = %v, want %v, with the shadowed one hidden", got, want)
	}
	if got, want := b[0].Expr, "units * 3"; got != want {
		t.Errorf("listed expression = %q, want %q from the folder", got, want)
	}
}

// Most documents have no formulas beside them, and that is the ordinary case
// rather than a fault: the drawer opens on the library alone and says nothing
// about a folder that was simply never used for this.
func TestAFolderWithNoFormulasBesideTheDocumentIsEmptyRatherThanBroken(t *testing.T) {
	lib := t.TempDir()
	copyFixtures(t, lib, "variance")
	beside := filepath.Join(t.TempDir(), "never-written-to")

	found, err := library.Load(beside)
	if err != nil {
		t.Fatalf("Load of a folder that is not there: %v", err)
	}

	b, l := split(found, loadInto(t, lib), beside, lib)

	if len(b) != 0 {
		t.Errorf("beside the document = %v, want nothing", idsOf(b))
	}
	if got, want := idsOf(l), []string{"variance"}; !equalNames(got, want) {
		t.Errorf("in the library = %v, want %v", got, want)
	}
}

// A person who keeps their documents in the same folder their formulas live in
// is not looking at two places, and should not be told they are. Reading that
// folder as both would put every formula under "beside this file" and leave the
// library looking empty, which is a false thing to say about where they are.
func TestADocumentSavedIntoTheLibraryFolderHasNothingBesideIt(t *testing.T) {
	dir := t.TempDir()
	copyFixtures(t, dir, "unit-margin", "variance")

	found := loadInto(t, dir)
	b, l := split(found, found, dir, dir)

	if len(b) != 0 {
		t.Errorf("beside the document = %v, want nothing when it is the library", idsOf(b))
	}
	if got, want := idsOf(l), []string{"unit-margin", "variance"}; !equalNames(got, want) {
		t.Errorf("in the library = %v, want %v", got, want)
	}
}

// Half the drawer can now have arrived from somebody else, so one thing they
// sent that will not parse must cost that one formula and not the panel. The
// rest are listed, and the failure names the file, because "a formula did not
// load" is not something a person can act on.
func TestOneUnreadableFileBesideTheDocumentCostsOneFormulaAndNotTheRest(t *testing.T) {
	beside, lib := t.TempDir(), t.TempDir()
	copyFixtures(t, beside, "unit-margin")
	copyFixtures(t, lib, "variance")
	if err := os.WriteFile(filepath.Join(beside, "broken.unof"), []byte("{ not json"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	found, err := library.Load(beside)
	if err == nil {
		t.Fatal("a folder holding an unreadable file reported no error")
	}
	if got := err.Error(); !strings.Contains(got, "broken.unof") {
		t.Errorf("error = %q, want it to name broken.unof", got)
	}

	b, l := split(found, loadInto(t, lib), beside, lib)

	if got, want := idsOf(b), []string{"unit-margin"}; !equalNames(got, want) {
		t.Errorf("beside the document = %v, want %v still listed", got, want)
	}
	if got, want := idsOf(l), []string{"variance"}; !equalNames(got, want) {
		t.Errorf("in the library = %v, want %v untouched by the bad file", got, want)
	}
}

// A CSV opened through the dialog has no file on disk behind it and so no folder
// to read: load takes a name and a reader, and the directory is gone by then.
// That workspace gets the drawer exactly as it looks today, rather than an empty
// group or an error about a folder nobody named.
func TestAWorkspaceWithNoFileOnDiskListsTheLibraryAlone(t *testing.T) {
	s, _ := loadedSales(t)
	stockLibrary(t, s, "unit-margin", "variance")

	beside, lib, err := s.sources()
	if err != nil {
		t.Fatalf("sources: %v", err)
	}
	if len(beside) != 0 {
		t.Errorf("beside the document = %v, want nothing for a workspace with no path", idsOf(beside))
	}
	if got, want := idsOf(lib), []string{"unit-margin", "variance"}; !equalNames(got, want) {
		t.Errorf("in the library = %v, want %v", got, want)
	}

	s.toggleDrawer()
	if got := len(s.drawer.list.Objects); got != 2 {
		t.Errorf("list holds %d rows, want 2", got)
	}
}

// The receiving end of the whole format: a formula that arrives beside a
// document is in, and the only step is opening the panel. There is no import,
// because an import would answer "how do I get this in" with a chore.
func TestAFormulaBesideTheDocumentIsListedWhenTheDrawerOpens(t *testing.T) {
	s, _, dir := besideSales(t, "unit-margin")
	stockLibrary(t, s, "std-deviation")

	s.toggleDrawer()

	got := drawerNames(s)
	if want := []string{"Unit margin", "Std. deviation"}; !equalNames(got, want) {
		t.Errorf("drawer = %v, want %v", got, want)
	}

	beside, _, err := s.sources()
	if err != nil {
		t.Fatalf("sources: %v", err)
	}
	if len(beside) != 1 || beside[0].dir != dir {
		t.Errorf("beside group = %v, want the one formula out of %s", beside, dir)
	}
}
