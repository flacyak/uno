package ui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/driver/desktop"
	"fyne.io/fyne/v2/storage"
	"fyne.io/fyne/v2/test"
)

const csvBody = "date,region,units\n2026-07-01,West,\"1,204\"\n2026-07-01,East,987\n"

// newTestShell builds a shell on a test window, which needs no display (I-6).
func newTestShell(t *testing.T) *Shell {
	t.Helper()
	test.NewTempApp(t)

	w := test.NewWindow(nil)
	t.Cleanup(w.Close)

	s := NewShell(w)
	w.SetContent(s.Content())
	return s
}

// writeCSV puts a file on disk and returns its URI, because a drop and a
// command-line argument both arrive as URIs the UI did not open itself.
func writeCSV(t *testing.T, name, body string) fyne.URI {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	return fileURI(t, p)
}

func fileURI(t *testing.T, path string) fyne.URI {
	t.Helper()
	return storage.NewFileURI(path)
}

func tabNames(s *Shell) []string {
	out := make([]string, 0, len(s.tabs.Items))
	for _, it := range s.tabs.Items {
		out = append(out, it.Text)
	}
	return out
}

// Check 6: the file lands in the already-open empty workspace and the tab takes
// its name, leaving no stray "Untitled 1" behind.
func TestFirstLoadFillsTheEmptyWorkspace(t *testing.T) {
	s := newTestShell(t)

	if got := tabNames(s); len(got) != 1 || got[0] != "Untitled 1" {
		t.Fatalf("cold start tabs = %v, want one Untitled 1", got)
	}
	if err := s.load("sales.csv", strings.NewReader(csvBody)); err != nil {
		t.Fatalf("load: %v", err)
	}

	if got := tabNames(s); len(got) != 1 || got[0] != "sales.csv" {
		t.Errorf("tabs = %v, want exactly [sales.csv]", got)
	}
	if s.active().sheet == nil {
		t.Error("active workspace has no sheet")
	}
}

// Check 7: a second file gets its own workspace, and the first keeps its sheet.
func TestSecondLoadAppendsAndSelectsANewTab(t *testing.T) {
	s := newTestShell(t)

	if err := s.load("first.csv", strings.NewReader(csvBody)); err != nil {
		t.Fatalf("load first: %v", err)
	}
	first := s.active()

	if err := s.load("second.csv", strings.NewReader(csvBody)); err != nil {
		t.Fatalf("load second: %v", err)
	}

	if got := tabNames(s); len(got) != 2 || got[1] != "second.csv" {
		t.Errorf("tabs = %v, want [first.csv second.csv]", got)
	}
	if s.active() == first {
		t.Error("the new tab was not selected")
	}
	if first.sheet == nil || first.sheet.Name != "first.csv" {
		t.Error("the first workspace lost its own sheet")
	}
}

// Check 18: a file uno cannot read leaves the workspace exactly as it was, and
// the error comes back to the caller rather than being shown here.
func TestFailedLoadLeavesTheWorkspaceUntouched(t *testing.T) {
	s := newTestShell(t)
	if err := s.load("good.csv", strings.NewReader(csvBody)); err != nil {
		t.Fatalf("load: %v", err)
	}
	before := s.active().sheet

	err := s.load("empty.csv", strings.NewReader(""))
	if err == nil {
		t.Fatal("want an error for an empty file, got nil")
	}
	if !strings.Contains(err.Error(), "file is empty") { // check 19
		t.Errorf("error = %q, want it to say the file is empty", err)
	}
	if s.active().sheet != before {
		t.Error("the sheet on screen changed despite the failure")
	}
	if got := tabNames(s); len(got) != 1 {
		t.Errorf("tabs = %v, want the failure to add none", got)
	}
}

// Check 9: closing the last tab leaves one empty workspace, not a blank window.
func TestClosingTheLastTabLeavesAnEmptyWorkspace(t *testing.T) {
	s := newTestShell(t)
	if err := s.load("sales.csv", strings.NewReader(csvBody)); err != nil {
		t.Fatalf("load: %v", err)
	}

	// Reproduce what DocTabs does when its close button is tapped: remove the
	// item, then report it. Going through s.tabs.OnClosed is also what proves
	// the handler is wired, since an unassigned one would panic here.
	closed := s.tabs.Items[0]
	s.tabs.Remove(closed)
	s.tabs.OnClosed(closed)

	if len(s.tabs.Items) != 1 {
		t.Fatalf("tabs = %v, want exactly one", tabNames(s))
	}
	if w := s.byTab[s.tabs.Items[0]]; w == nil || w.sheet != nil {
		t.Error("the replacement tab should be a fresh empty workspace")
	}
}

// Check 8: the "+" adds an empty workspace whose status reads "no file open".
func TestCreateTabAddsAnEmptyWorkspace(t *testing.T) {
	s := newTestShell(t)
	if err := s.load("sales.csv", strings.NewReader(csvBody)); err != nil {
		t.Fatalf("load: %v", err)
	}

	tab := s.tabs.CreateTab()
	s.tabs.Append(tab)
	s.tabs.Select(tab)

	if got := s.status.Text; got != "no file open" {
		t.Errorf("status = %q, want %q", got, "no file open")
	}
}

// Checks 10 and 11: the status bar always describes the active workspace.
func TestStatusFollowsTheActiveTab(t *testing.T) {
	s := newTestShell(t)
	if err := s.load("sales.csv", strings.NewReader(csvBody)); err != nil {
		t.Fatalf("load: %v", err)
	}
	loaded := s.tabs.Selected()

	want := "2 rows · 3 cols · UTF-8 · delimiter ','"
	if got := s.status.Text; got != want {
		t.Errorf("status = %q, want %q", got, want)
	}

	empty := s.tabs.CreateTab()
	s.tabs.Append(empty)
	s.tabs.Select(empty)
	if got := s.status.Text; got != "no file open" {
		t.Errorf("status after switching = %q, want %q", got, "no file open")
	}

	s.tabs.Select(loaded)
	if got := s.status.Text; got != want {
		t.Errorf("status after switching back = %q, want %q", got, want)
	}
}

// Check 14: three files land as three workspaces, left to right, last selected.
func TestDropOpensOneWorkspacePerFile(t *testing.T) {
	s := newTestShell(t)

	uris := []fyne.URI{
		writeCSV(t, "a.csv", csvBody),
		writeCSV(t, "b.csv", csvBody),
		writeCSV(t, "c.csv", csvBody),
	}
	if failed := s.openAll(uris); failed != nil {
		t.Fatalf("openAll reported failures: %v", failed)
	}

	if got := tabNames(s); len(got) != 3 ||
		got[0] != "a.csv" || got[1] != "b.csv" || got[2] != "c.csv" {
		t.Fatalf("tabs = %v, want [a.csv b.csv c.csv]", got)
	}
	if s.tabs.Selected() != s.tabs.Items[2] {
		t.Error("the last dropped file should be selected")
	}
}

// Check 15: the good files open and exactly one complaint names only the bad one.
func TestDropOpensTheGoodFilesAndNamesOnlyTheBadOne(t *testing.T) {
	s := newTestShell(t)

	uris := []fyne.URI{
		writeCSV(t, "good.csv", csvBody),
		writeCSV(t, "bad.csv", ""),
		writeCSV(t, "alsogood.csv", csvBody),
	}
	failed := s.openAll(uris)

	if len(failed) != 1 || failed[0] != "bad.csv" {
		t.Errorf("failed = %v, want only [bad.csv]", failed)
	}
	if got := tabNames(s); len(got) != 2 ||
		got[0] != "good.csv" || got[1] != "alsogood.csv" {
		t.Errorf("tabs = %v, want the two good files", got)
	}
}

// Check 16: dragged text or a web URL is not ours to open, and saying so would
// be an error nobody asked for.
func TestDropIgnoresNonFileURIsSilently(t *testing.T) {
	s := newTestShell(t)

	u, err := storage.ParseURI("https://example.com/data.csv")
	if err != nil {
		t.Fatalf("ParseURI: %v", err)
	}
	if failed := s.openAll([]fyne.URI{u}); failed != nil {
		t.Errorf("failed = %v, want none", failed)
	}
	if got := tabNames(s); len(got) != 1 || got[0] != "Untitled 1" {
		t.Errorf("tabs = %v, want the workspace untouched", got)
	}
}

// A path named on the command line is how a file-manager double-click arrives,
// and it must take the same door as a drop.
func TestOpenPathsLoadsFromTheCommandLine(t *testing.T) {
	s := newTestShell(t)
	u := writeCSV(t, "argv.csv", csvBody)

	s.OpenPaths([]string{u.Path()})

	if got := tabNames(s); len(got) != 1 || got[0] != "argv.csv" {
		t.Errorf("tabs = %v, want [argv.csv]", got)
	}
	if s.active().sheet == nil {
		t.Error("the file named on the command line did not load")
	}
}

func TestGroupPutsCommasInARowCount(t *testing.T) {
	for _, c := range []struct {
		n    int
		want string
	}{{0, "0"}, {999, "999"}, {1000, "1,000"}, {4812, "4,812"}, {1234567, "1,234,567"}} {
		if got := group(c.n); got != c.want {
			t.Errorf("group(%d) = %q, want %q", c.n, got, c.want)
		}
	}
}

// Checks 2 and 3: File ▸ Open… and its shortcut are the same door, and one
// shortcut definition covers every desktop.
func TestOpenIsReachableFromTheMenuAndAShortcut(t *testing.T) {
	s := newTestShell(t)

	menus := s.win.MainMenu()
	if menus == nil || len(menus.Items) == 0 {
		t.Fatal("no main menu")
	}
	file := menus.Items[0]
	if file.Label != "File" {
		t.Fatalf("first menu = %q, want File", file.Label)
	}

	var open *fyne.MenuItem
	for _, it := range file.Items {
		if strings.HasPrefix(it.Label, "Open") {
			open = it
		}
	}
	if open == nil {
		t.Fatal("no Open… item in the File menu")
	}

	sc, ok := open.Shortcut.(*desktop.CustomShortcut)
	if !ok {
		t.Fatalf("shortcut = %T, want *desktop.CustomShortcut", open.Shortcut)
	}
	if sc.KeyName != fyne.KeyO {
		t.Errorf("shortcut key = %v, want O", sc.KeyName)
	}
	// KeyModifierShortcutDefault is Cmd on macOS and Ctrl elsewhere, which is
	// why there is one definition rather than a build-tagged pair.
	if sc.Modifier != fyne.KeyModifierShortcutDefault {
		t.Errorf("shortcut modifier = %v, want the platform default",
			sc.Modifier)
	}
}

// Choosing a file raises a dialog rather than reaching the filesystem here: the
// UI never opens anything itself (I-6).
func TestChooseFileRaisesADialog(t *testing.T) {
	s := newTestShell(t)

	if top := s.win.Canvas().Overlays().Top(); top != nil {
		t.Fatalf("an overlay was already up: %T", top)
	}
	s.chooseFile()

	if s.win.Canvas().Overlays().Top() == nil {
		t.Error("Open… raised no dialog")
	}
	// Check 4: dismissing it must leave the workspace as it was.
	if got := tabNames(s); len(got) != 1 || got[0] != "Untitled 1" {
		t.Errorf("tabs = %v, want the workspace untouched", got)
	}
}
