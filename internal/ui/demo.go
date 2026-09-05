//go:build demo

package ui

import (
	"os"
	"time"

	"fyne.io/fyne/v2"

	"github.com/flacyak/uno/internal/document"
)

// This file is the scripted preview: the app driving itself through one short
// story so a recorder can film it. It is behind the "demo" build tag because it
// is a filming rig, not a feature — the shipped binary compiles demo_off.go
// instead and carries none of this.
//
// The story is told with the keyboard: arrows to reach a cell, Enter to open it,
// Enter again to commit. That is the gesture worth showing — it is the one uno
// gained, and the one a pointer cannot demonstrate here anyway, because Hyprland
// offers dispatchers for keys but none for a pointer button, so no
// compositor-level tool on this machine can click the grid.
//
// It is still driven from inside the process rather than through hyprctl, so the
// script and the recorder share one clock. What that costs in fidelity it pays
// back at the one place fidelity matters: every key goes to whatever the canvas
// has focused, which is exactly where the driver puts a real one. An arrow that
// reached nothing would film as a preview that goes nowhere, rather than as a
// mock-up that looks right.

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

// The story the preview tells. Rows 1, 3 and 5 of testdata/sales-q3.csv hold
// 1,204, 1,455 and 2,038 in units, which is why that column is badged text? —
// the separators do not parse. Correcting three of them by hand is the setup;
// the app noticing and offering to do the other 3,149 is the point.
type demoFix struct {
	at    document.Cell
	value string
}

var demoFixes = []demoFix{
	{document.Cell{Row: 0, Col: 4}, "1204"},
	{document.Cell{Row: 2, Col: 4}, "1455"},
	{document.Cell{Row: 4, Col: 4}, "2038"},
}

// Beats, as offsets from the moment the driver starts. They are absolute rather
// than a list of gaps so the timeline can be read off the file and matched
// against the recording, and so a slow step steals its time from the following
// hold instead of shifting everything after it.
const (
	beatOpen  = 1400 * time.Millisecond  // the drop target has been read by now
	beatFix1  = 3400 * time.Millisecond  // the grid and its type badges have
	beatFix2  = 6400 * time.Millisecond  // the first correction crosses four columns
	beatFix3  = 8800 * time.Millisecond  // the other two only step down two rows
	beatApply = 12400 * time.Millisecond // the offer has been up long enough to read
	beatEnd   = 14800 * time.Millisecond

	// The pacing inside one correction. These are gaps and not offsets because
	// what matters about them is the rhythm, and because the three corrections
	// have to look like the same gesture repeated.
	arrowGap  = 180 * time.Millisecond // between arrow presses, so travel reads as travel
	openPause = 460 * time.Millisecond // between arriving at a cell and opening it
	keystroke = 110 * time.Millisecond // fast enough to read, slow enough to see
	preEnter  = 300 * time.Millisecond // the pause before committing a value

	// arrowLimit bounds the walk to a cell. A target the arrows cannot reach is
	// a mis-scripted story, and it must film as one rather than hang the take.
	arrowLimit = 64
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

	// Three cells corrected by hand, each the same gesture: arrows to reach the
	// cell, Enter to open it, the value typed where it sits, Enter to commit.
	// The repetition is the argument — by the third one the app has seen enough
	// to ask.
	for i, beat := range []time.Duration{beatFix1, beatFix2, beatFix3} {
		at(beat)
		s.playFix(step, demoFixes[i])
	}

	// The bar has risen from the bottom of the window by now, carrying the
	// offer. The hold before pressing it is the beat someone reads it in.
	at(beatApply)
	step(func() {
		if w := s.active(); w != nil {
			s.applyProposal(w) // the same call the bar's own button makes
		}
	})

	// The tail is a resting state: units is badged num, the status bar reads
	// "4 edits · unsaved", the tab carries its dot, and a looping preview holds
	// there long enough to be read before it starts over.
	at(beatEnd)
}

// playFix is one cell corrected the way a person corrects it, without ever
// leaving the keyboard: arrow to the cell, Enter to open it on the value already
// there, type, Enter to commit.
func (s *Shell) playFix(step func(func()), fix demoFix) {
	s.walkTo(step, fix.at)
	time.Sleep(openPause)
	step(func() { s.press(fyne.KeyReturn) })
	time.Sleep(openPause)

	// The value is typed a character at a time rather than assigned, because a
	// field that fills instantly reads as a screenshot rather than as an edit.
	// It is set rather than struck because Enter opens the cell on what is in
	// it, and a person replacing that would clear it first; the clearing is not
	// part of the story, and filming three backspaces before every correction
	// would bury the gesture the preview is about.
	for i := range fix.value {
		step(func() {
			if w := s.active(); w != nil && w.editing {
				w.inline.SetText(fix.value[:i+1])
			}
		})
		time.Sleep(keystroke)
	}

	time.Sleep(preEnter)
	step(func() { s.press(fyne.KeyReturn) }) // the editor's own submit, and the commit
}

// walkTo arrows from the chosen cell to another one, a key at a time, so the
// travel is on screen rather than a jump. It reads where it is between presses
// instead of counting them out in advance, which is what keeps it honest: if an
// arrow does not move the selection the walk stops, and the take shows it.
func (s *Shell) walkTo(step func(func()), to document.Cell) {
	for range arrowLimit {
		arrived := true
		step(func() {
			w := s.active()
			if w == nil || w.sheet == nil || w.active == to {
				return
			}
			arrived = false
			s.press(arrowToward(w.active, to))
		})
		if arrived {
			return
		}
		time.Sleep(arrowGap)
	}
}

// arrowToward is the one key that gets from here nearer to there. Columns are
// crossed before rows for no reason but rhythm: the long move happens first, and
// the three corrections then share the short one.
func arrowToward(from, to document.Cell) fyne.KeyName {
	switch {
	case to.Col > from.Col:
		return fyne.KeyRight
	case to.Col < from.Col:
		return fyne.KeyLeft
	case to.Row > from.Row:
		return fyne.KeyDown
	default:
		return fyne.KeyUp
	}
}

// press is one key struck at the point a real one lands. The driver hands a key
// event to whatever the canvas has focused and so does this, which is what makes
// the recording evidence about focus as well as about the grid: the arrows reach
// the table because the table has the keyboard, and Enter reaches the cell
// editor because opening one moved the keyboard into it.
func (s *Shell) press(name fyne.KeyName) {
	c := s.win.Canvas()
	if c == nil {
		return
	}
	if f := c.Focused(); f != nil {
		f.TypedKey(&fyne.KeyEvent{Name: name})
	}
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
