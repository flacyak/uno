//go:build screenshot

package uitest

import (
	"path/filepath"
	"testing"
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
