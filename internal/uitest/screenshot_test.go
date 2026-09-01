//go:build screenshot

package uitest

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/flacyak/uno/internal/document"
	"github.com/flacyak/uno/internal/ingest"
)

// TestColdStart is the empty app: one workspace tab, the drop target, and a
// status bar reading "no file open".
func TestColdStart(t *testing.T) {
	r := launch(t, build(t))
	shot(t, r, "cold-start.png")
}

// TestGridLoaded is the milestone itself: a CSV on screen, named on the command
// line so no dialog has to be driven to get it there.
func TestGridLoaded(t *testing.T) {
	bin := build(t)
	csv := filepath.Join(repoRoot(t), "testdata", "sales-q3.csv")

	r := launch(t, bin, csv)
	shot(t, r, "grid-loaded.png")
}

// TestReopenedDocument is the milestone itself: a .uno built somewhere else,
// opened by the real binary with no CSV anywhere near it. The container carries
// the bytes and the log, so the grid comes back with the edits already applied.
func TestReopenedDocument(t *testing.T) {
	bin := build(t)
	uno := writeDocument(t)

	r := launch(t, bin, uno)
	shot(t, r, "reopened-uno.png")
}

// writeDocument saves testdata/sales-q3.csv as a .uno with a few cells fixed by
// hand, into a directory holding nothing else. Nothing the reader does may reach
// back to the CSV, and the empty directory is what proves it.
func writeDocument(t *testing.T) string {
	t.Helper()

	raw, err := os.ReadFile(filepath.Join(repoRoot(t), "testdata", "sales-q3.csv"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	sh, err := ingest.Read("sales-q3.csv", bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("ingest: %v", err)
	}

	// The units column is flagged because its thousands separators do not parse.
	// Fixing the ones on screen is what the badge changing proves.
	for _, row := range []int{0, 2, 4} {
		if err := sh.Set(row, 4, strings.ReplaceAll(sh.At(row, 4), ",", "")); err != nil {
			t.Fatalf("edit: %v", err)
		}
	}

	path := filepath.Join(t.TempDir(), "sales-q3.uno")
	err = document.Write(path, &document.Document{
		Manifest: document.Manifest{
			Source: document.Source{Name: "sales-q3.csv"},
			Sheet:  document.SheetRef{Rows: sh.Rows(), Cols: sh.Cols()},
		},
		Raw:   raw,
		State: document.State{Active: document.Cell{Row: 2, Col: 4}},
		Edits: sh.Edits(),
	})
	if err != nil {
		t.Fatalf("write .uno: %v", err)
	}
	return path
}
