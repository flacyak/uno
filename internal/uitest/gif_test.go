//go:build screenshot

package uitest

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// previewRun is how long the recorder films for. It is the script's own length
// in internal/ui/demo.go plus a moment, so the last beat is held rather than cut.
const previewRun = 14000 * time.Millisecond

// minDistinctFrames is the floor for a recording that actually caught the app
// doing something. The script has five visible states and types four
// characters, so a good take has dozens of distinct frames; anything near this
// number means the window sat still and the GIF is of a photograph.
const minDistinctFrames = 8

// TestPreviewGIF films the scripted preview and encodes docs/preview.gif.
//
// The window is the real binary's, built with the demo tag so it drives itself:
// there is no pointer dispatcher on this compositor, so a preview that opens a
// file and then edits a cell cannot be produced from outside the process.
//
// This writes into .screenshots, which is ignored. Promoting a take to
// docs/preview.gif is a deliberate copy, because which take ships is a judgement
// about what looks right and not something a test should decide.
func TestPreviewGIF(t *testing.T) {
	bin := build(t, "demo")

	// The script reads the file from the environment rather than the command
	// line: main.go opens its arguments before the window is shown, and the
	// preview opens on the empty drop target.
	t.Setenv("UNO_DEMO_FILE", filepath.Join(repoRoot(t), "testdata", "sales-q3.csv"))

	// The script holds on the drop target until this file appears, so the story
	// and the recording share a first frame. Without it the opening beats play
	// while the window is still being floated and settled, and the preview opens
	// on a grid that is already loaded.
	cue := filepath.Join(t.TempDir(), "rolling")
	t.Setenv("UNO_DEMO_CUE", cue)

	r := launch(t, bin)
	if r.W < 900 {
		t.Fatalf("window is %dx%d: it did not float to the size main.go asks for, "+
			"so the preview would ship clipped", r.W, r.H)
	}

	frames, err := record(r, t.TempDir(), previewRun, func() {
		if err := os.WriteFile(cue, nil, 0o644); err != nil {
			t.Errorf("cue the script: %v", err)
		}
	})
	if err != nil {
		t.Fatalf("record: %v", err)
	}
	if len(frames) < 2 {
		t.Fatalf("captured %d frames, which is not a recording", len(frames))
	}

	// The first and last frames are checked the way a still is: right size, and
	// not the flat colour a declined portal request leaves behind.
	for _, f := range []frame{frames[0], frames[len(frames)-1]} {
		if err := checkPNG(f.path, r); err != nil {
			t.Fatalf("frame at %v: %v", f.at.Round(time.Millisecond), err)
		}
	}

	moved, err := differ(frames[0], frames[len(frames)-1])
	if err != nil {
		t.Fatalf("compare frames: %v", err)
	}
	if !moved {
		t.Fatal("the recording ends where it began: the script did not run")
	}

	n, err := distinct(frames)
	if err != nil {
		t.Fatalf("count distinct frames: %v", err)
	}
	if n < minDistinctFrames {
		t.Fatalf("only %d of %d frames differ: the window barely changed",
			n, len(frames))
	}

	dir := filepath.Join(repoRoot(t), ".screenshots")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("make screenshot dir: %v", err)
	}

	list := filepath.Join(t.TempDir(), "frames.ffconcat")
	if err := playlist(frames, previewRun, list); err != nil {
		t.Fatalf("write playlist: %v", err)
	}

	out := filepath.Join(dir, "preview.gif")
	if err := encode(list, out); err != nil {
		t.Fatalf("encode: %v", err)
	}

	fi, err := os.Stat(out)
	if err != nil {
		t.Fatalf("stat gif: %v", err)
	}
	t.Logf("preview.gif: %d frames, %d distinct, %.1f MiB, %dx%d window",
		len(frames), n, float64(fi.Size())/(1<<20), r.W, r.H)
}
