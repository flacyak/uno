//go:build demo

package ui

import (
	"os"
	"time"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/widget"

	"github.com/flacyak/uno/internal/document"
)

// This file is the scripted preview: the app driving itself through one short
// story so a recorder can film it. It is behind the "demo" build tag because it
// is a filming rig, not a feature — the shipped binary compiles demo_off.go
// instead and carries none of this.
//
// The script exists because the preview cannot be driven from outside. Choosing
// a cell means clicking one, and Hyprland offers dispatchers for keys but none
// for a pointer button, so no compositor-level tool on this machine can reach
// the grid. Driving the shell from inside is what makes the recording possible
// at all — and it enters at tapCell, which is the one call a cell widget makes
// when a pointer lands on it, so the selection, the editor that opens on the
// second click, the commit and the status refresh are all the ones a person's
// clicks would produce rather than a mock-up of them.

// demoFile names the file the script opens. It is an environment variable
// rather than an argument because the story starts on the empty drop target:
// main.go opens anything in os.Args before the window is ever shown, which
// would skip the first beat entirely.
const demoFile = "UNO_DEMO_FILE"

// demoCue names a file the script waits for before it plays a note.
//
// Without it the two clocks are unrelated. The script starts when the driver
// does; the recorder cannot start until the window has mapped, floated and
// settled, which is seconds later. The first beats play to nobody and the
// preview opens on a grid that is already there. Waiting for the recorder to
// say it is filming is what puts the story's first frame in the film's first
// frame.
//
// A file rather than a signal because this has to build everywhere the app
// does, and SIGUSR1 does not exist on Windows.
const demoCue = "UNO_DEMO_CUE"

// cuePoll is how often the cue is checked for. Fine enough that the wait costs
// less than a frame.
const cuePoll = 20 * time.Millisecond

// cueWait bounds it, so a demo-tagged binary launched by hand still plays
// rather than hanging on a cue nobody is going to give.
const cueWait = 60 * time.Second

// The beat the whole preview is built around: E1 of testdata/sales-q3.csv holds
// "1,204", which is why the units column is badged text? — the separators do not
// parse. Retyping it without the comma is the smallest complete edit uno makes.
var (
	demoCell  = document.Cell{Row: 0, Col: 4}
	demoValue = "1204"
)

// Beats, as offsets from the moment the driver starts. They are absolute rather
// than a list of gaps so the timeline can be read off the file and matched
// against the recording, and so a slow step steals its time from the following
// hold instead of shifting everything after it.
const (
	beatOpen   = 1600 * time.Millisecond // the drop target has been read by now
	beatSelect = 4200 * time.Millisecond // the grid and its type badges have
	beatEdit   = 5000 * time.Millisecond // the flagged cell is highlighted
	beatType   = 5600 * time.Millisecond // the caret is sitting in the cell
	beatEnd    = 9000 * time.Millisecond

	keystroke = 110 * time.Millisecond // fast enough to read, slow enough to see
	preEnter  = 400 * time.Millisecond // the pause before committing a value
)

// startDemo arms the script when the environment names a file, and does nothing
// otherwise, so a demo-tagged binary is still an ordinary uno when launched by
// hand.
//
// OnStarted is the same hook the macOS document handler uses, and for the same
// reason: it fires after the driver has initialised and before the event loop
// begins ticking, which is the first moment there is a canvas to focus and a
// window to film.
func (s *Shell) startDemo() {
	path := os.Getenv(demoFile)
	if path == "" {
		return
	}
	fyne.CurrentApp().Lifecycle().SetOnStarted(func() { go s.runDemo(path) })
}

// runDemo plays the story on its own goroutine, handing every step that touches
// the UI to the UI goroutine (I-7). It waits for each one to land before timing
// the next, so the script's clock measures what is on screen rather than what
// has been queued.
func (s *Shell) runDemo(path string) {
	waitForCue(os.Getenv(demoCue))

	start := time.Now()
	at := func(d time.Duration) { time.Sleep(time.Until(start.Add(d))) }
	step := func(f func()) { fyne.DoAndWait(f) }

	// A file arrives. This is the door a drop and a double-click use too.
	at(beatOpen)
	step(func() { s.OpenPaths([]string{path}) })

	// Both beats are clicks on the same square, through the same tapCell a
	// pointer reaches. The first chooses the cell — highlight, editor bar and
	// cell reference, three things on screen from one selection. The second
	// opens it, which is the gesture the preview is now for: the fix happens in
	// the grid, at the value, rather than at the top of the window.
	at(beatSelect)
	step(func() { s.click(demoCell) })

	at(beatEdit)
	step(func() { s.click(demoCell) })

	// The value is typed a character at a time rather than assigned, because a
	// field that fills instantly reads as a screenshot rather than as an edit.
	at(beatType)
	for i := range demoValue {
		step(func() {
			if w := s.active(); w != nil && w.editing {
				w.inline.SetText(demoValue[:i+1])
			}
		})
		time.Sleep(keystroke)
	}

	time.Sleep(preEnter)
	step(func() {
		if w := s.active(); w != nil {
			s.endEdit(w, true) // the same call Enter in the cell makes
		}
	})

	// The tail is a resting state: the status bar reads "1 edit · unsaved", the
	// tab carries its dot, and a looping preview holds there long enough to be
	// read before it starts over.
	at(beatEnd)
}

// click is one press on a cell of the grid, at the point a real one lands: the
// cell widget's Tapped calls exactly this. Going through it rather than through
// table.Select is what makes the second click open the editor instead of being
// a selection the table discards for naming the cell it already holds.
func (s *Shell) click(at document.Cell) {
	w := s.active()
	if w == nil || w.table == nil {
		return
	}
	s.tapCell(w, widget.TableCellID{Row: at.Row, Col: at.Col})
}

// waitForCue blocks until the recorder has a camera running, or until it is
// clear nobody is holding one.
func waitForCue(path string) {
	if path == "" {
		return
	}
	for deadline := time.Now().Add(cueWait); time.Now().Before(deadline); {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(cuePoll)
	}
}
