package ui

import (
	"fmt"
	"image/color"
	"strconv"
	"strings"
	"time"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/canvas"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"

	"github.com/flacyak/uno/internal/pattern"
)

// slideSpan is how long the bar takes to arrive or leave. Long enough to read
// as motion and see where the thing came from, short enough that answering the
// question twice in a row does not feel like waiting for it.
//
// The lower bound came from the preview rather than from taste. At the twelve
// frames a second docs/preview.gif is encoded at, 220ms is two frames of travel,
// which is a jump with a smear in the middle rather than a bar that slid.
const slideSpan = 320 * time.Millisecond

// proposalBar is where the app asks its question: a strip that rises from the
// bottom edge of the window and drops back out of it when it has an answer.
//
// It is a bar and not a dialog because the person is in the middle of typing,
// and interrupting the work in order to offer to finish it is a worse trade than
// waiting to be noticed. It slides rather than appearing because a thing that
// blinks into existence over a grid reads as a glitch, and because the way it
// leaves is the acknowledgement: the offer goes back where it came from.
//
// There is one bar and not one per workspace. It says what the selected tab is
// about, the way the status bar and the cell reference do, and the proposal
// itself stays on the workspace so nothing about one file reaches another (I-3).
type proposalBar struct {
	box     *fyne.Container
	lay     *slideLayout
	bg      *canvas.Rectangle
	edge    *canvas.Rectangle
	text    *widget.Label
	apply   *widget.Button
	preview *widget.Button
	later   *widget.Button

	// showing is where the bar is meant to be, which is not where it is while it
	// is on its way there. Asking the animation would mean asking a float
	// whether it had finished.
	showing bool
	anim    *fyne.Animation
}

func (s *Shell) newProposalBar() *proposalBar {
	b := &proposalBar{
		lay:     &slideLayout{off: 1},
		text:    widget.NewLabel(""),
		apply:   widget.NewButton("Apply", func() { s.applyProposal(s.active()) }),
		preview: widget.NewButton("Preview…", func() { s.previewProposal(s.active()) }),
		later:   widget.NewButton("Not now", func() { s.dismissProposal(s.active()) }),
	}

	// The bar floats over the grid, so it needs a ground of its own: a
	// transparent strip would be read through by the rows behind it. The menu
	// surface and not the overlay one, because the overlay colour is the same
	// white as the grid in the light theme, and a bar that matches what it is
	// sitting on top of reads as another row rather than as a thing that arrived.
	b.bg = canvas.NewRectangle(color.Transparent)
	b.edge = canvas.NewRectangle(color.Transparent)
	b.edge.SetMinSize(fyne.NewSize(0, 1))

	row := container.NewBorder(b.edge, nil, nil,
		container.NewHBox(b.apply, b.preview, b.later), b.text)
	b.box = container.NewStack(b.bg, container.NewPadded(row))
	b.box.Hide()
	return b
}

// paint takes the bar's colours from the theme as it is now.
//
// They cannot be read once and kept. The window's content is built before the
// app has settled which variant it is running, so a bar painted at construction
// comes out of the dark palette and lays a near-black strip across a light grid.
// Reading them at every show also means the bar follows a theme changed while
// uno is open.
func (b *proposalBar) paint() {
	repaint(b.bg, theme.Color(theme.ColorNameMenuBackground))
	repaint(b.edge, theme.Color(theme.ColorNameSeparator))
}

func repaint(r *canvas.Rectangle, c color.Color) {
	if r.FillColor == c {
		return // showProposal lands here on every selection; a repaint is not free
	}
	r.FillColor = c
	r.Refresh()
}

// edge says which side of the window a panel slides in from. The bar comes up
// from the bottom because that is where a question about the whole sheet
// belongs; the formula drawer comes in from the right, next to the column it
// acts on.
type edge int

const (
	// fromBottom is the zero value, so a layout that says nothing keeps doing
	// what the proposal bar has always done.
	fromBottom edge = iota
	fromRight
)

// slideLayout puts the window's contents underneath and a panel against one edge
// of them, at whatever point the slide has reached. An offset of 0 has the panel
// fully in and 1 has it fully outside the window's edge, where the window itself
// is what hides it — which is why a panel is anchored to the window rather than
// to the tab, and why nothing has to clip it.
//
// It holds exactly two objects, the contents and the panel, so two panels nest
// rather than sharing one layout. That keeps each one's arithmetic about one
// axis, and it is why the drawer overlaps the bar instead of fighting it for the
// same corner.
type slideLayout struct {
	edge  edge
	off   float32
	panel fyne.CanvasObject
	size  fyne.Size
}

func (l *slideLayout) MinSize(objs []fyne.CanvasObject) fyne.Size {
	return objs[0].MinSize()
}

func (l *slideLayout) Layout(objs []fyne.CanvasObject, size fyne.Size) {
	l.size, l.panel = size, objs[1]
	objs[0].Resize(size)
	objs[0].Move(fyne.NewPos(0, 0))
	l.place()
}

// place puts the panel where the slide has got to. The animation calls it every
// frame, and it moves one object rather than laying the whole window out again.
//
// The panel is measured along the axis it travels and stretched along the other,
// so a drawer is as tall as the window and as wide as its own contents. The
// offset is a fraction of that measured size, which is what makes 1 mean "one
// panel outside the edge" whichever edge it is.
func (l *slideLayout) place() {
	if l.panel == nil || l.size.IsZero() {
		return
	}

	if l.edge == fromRight {
		w := l.panel.MinSize().Width
		l.panel.Resize(fyne.NewSize(w, l.size.Height))
		l.panel.Move(fyne.NewPos(l.size.Width-w+l.off*w, 0))
		return
	}

	h := l.panel.MinSize().Height
	l.panel.Resize(fyne.NewSize(l.size.Width, h))
	l.panel.Move(fyne.NewPos(0, l.size.Height-h+l.off*h))
}

// showProposal points the bar at what the selected workspace is being asked
// about, and sends it away when that is nothing.
func (s *Shell) showProposal() {
	if s.bar == nil {
		return
	}
	w := s.active()
	if w == nil || w.proposal == nil {
		s.slide(false)
		return
	}

	p := w.proposal
	text := fmt.Sprintf("%s · %s from %s",
		p.Header, p.Prog.Describe(), plural(p.Affects, "more cell"))

	// An ambiguous proposal leads with the preview. The examples do not settle
	// which rule was meant, and a guess that says it is a guess is worth making
	// where one that does not is not.
	s.bar.apply.Importance = widget.HighImportance
	s.bar.preview.Importance = widget.MediumImportance
	if p.Ambiguous {
		text += " · more than one rule fits"
		s.bar.apply.Importance = widget.MediumImportance
		s.bar.preview.Importance = widget.HighImportance
	}

	// refreshStatus lands here on every selection, and SetText redraws whether
	// or not the words changed.
	if s.bar.text.Text != text {
		s.bar.text.SetText(text)
	}
	s.bar.apply.Refresh()
	s.bar.preview.Refresh()
	s.bar.paint()
	s.slide(true)
}

// slide runs the bar in or out, and does nothing when it is already going the
// way it is asked to. Restating the question while the bar is up rewrites the
// label and leaves the bar where it is, rather than dropping it to fetch it
// straight back.
func (s *Shell) slide(in bool) {
	b := s.bar
	if b.showing == in {
		return
	}
	b.showing = in

	if b.anim != nil {
		b.anim.Stop()
	}
	b.box.Show() // it has to be on screen to be seen moving off it

	from, to := b.lay.off, float32(1)
	if in {
		to = 0
	}
	b.anim = fyne.NewAnimation(slideSpan, func(f float32) {
		b.lay.off = from + (to-from)*f
		b.lay.place()
		if f == 1 && !in {
			b.box.Hide()
		}
	})
	b.anim.Curve = fyne.AnimationEaseInOut
	b.anim.Start()
}

// rescan takes the question away and looks for the next one. Every path that
// changes the log ends here, so the bar can never describe a sheet that has
// moved on underneath it.
//
// It runs on the UI goroutine, where the design notes had it on a worker. The
// measurement is what changed the answer: a scan of the 4,812 rows of
// testdata/sales-q3.csv takes about six milliseconds, which is inside a frame,
// and it only runs at all once a column has enough examples to ask about — Snap
// copies nothing and finds nothing after an ordinary edit. Handing that off
// would cost a stale-result guard and a second goroutine writing to the bar, and
// buy back a hitch nobody can feel. It is worth revisiting at roughly ten times
// this file, where the scan crosses a frame and the Enter key would start to
// stick.
func (s *Shell) rescan(w *workspace) {
	w.proposal = nil
	if w.sheet != nil {
		// A proposal the person has already refused is not asked again. It is
		// keyed by the program, so a different question about the same column
		// still gets through.
		if p, ok := pattern.Snap(w.sheet).Propose(); ok && w.dismissed[p.Col] != p.Prog.String() {
			w.proposal = &p
		}
	}
	s.showProposal()
}

// applyProposal is the person saying yes. It goes through sheet.Apply, so what
// lands in the log is the program and not the 3,149 cells it changed, and one
// press of undo takes all of them back.
func (s *Shell) applyProposal(w *workspace) {
	if w == nil || w.sheet == nil || w.proposal == nil {
		return
	}
	p := w.proposal

	// An editor left open in the grid is pointed at a value about to be
	// rewritten, and nothing in it was committed.
	s.endEdit(w, false)

	if err := w.sheet.Apply(p.Col, p.Prog); err != nil {
		dialog.ShowError(err, s.win)
		return
	}

	// The bar is sent away before the grid is redrawn, not after. Refreshing
	// 4,812 rows takes long enough to see, and doing it first holds the answered
	// question on screen for the whole of it.
	s.rescan(w)

	// A whole column changed, and so did the badge in its header.
	w.table.Refresh()
	w.showActive()
	s.refreshStatus()
}

// dismissProposal is the person saying not now. The refusal is remembered
// against the program rather than against the column, so this does not silence a
// column for the session — a different question about it is still worth asking.
func (s *Shell) dismissProposal(w *workspace) {
	if w == nil || w.proposal == nil {
		return
	}
	w.dismissed[w.proposal.Col] = w.proposal.Prog.String()
	w.proposal = nil
	s.showProposal()
}

// previewProposal shows what the offer would do to the rows nobody has looked
// at. It is the part that makes an inference safe to accept: the person is
// agreeing to a diff rather than to a description of one.
func (s *Shell) previewProposal(w *workspace) {
	if w == nil || w.proposal == nil {
		return
	}
	p := w.proposal

	lines := make([]string, 0, len(p.Sample)+1)
	for _, c := range p.Sample {
		lines = append(lines, fmt.Sprintf("%-8s %s → %s",
			colName(p.Col)+strconv.Itoa(c.Row+1), c.Was, c.Now))
	}
	if rest := p.Affects - len(p.Sample); rest > 0 {
		lines = append(lines, "", "… and "+plural(rest, "more cell"))
	}

	body := widget.NewLabelWithStyle(strings.Join(lines, "\n"),
		fyne.TextAlignLeading, fyne.TextStyle{Monospace: true})
	scroll := container.NewVScroll(body)
	scroll.SetMinSize(fyne.NewSize(460, 320))

	d := dialog.NewCustomConfirm(
		p.Header+" · "+p.Prog.Describe(), "Apply", "Not now", scroll,
		func(yes bool) {
			if yes {
				s.applyProposal(w)
				return
			}
			s.dismissProposal(w)
		}, s.win)
	d.Show()
}
