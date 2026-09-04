// Package main is deliberately thin: it wires a window to a shell and gets out
// of the way. Everything testable lives under internal/.
package main

import (
	"os"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/app"

	"github.com/flacyak/uno/internal/ui"
)

// Set by the linker at release time; see .github/workflows/release.yml.
var version = "dev"

func main() {
	// The ID is what gives the app a preferences store and a per-user data
	// directory, which is where later milestones keep the recents list.
	a := app.NewWithID("io.uno.app")

	w := a.NewWindow("uno")
	shell := ui.NewShell(w)

	w.SetContent(shell.Content())
	w.Resize(fyne.NewSize(1100, 720))
	w.CenterOnScreen()

	// Files named on the command line are how a file-manager double-click
	// arrives on Linux and Windows. They go through the same door as a drop, and
	// report the same way.
	shell.OpenPaths(os.Args[1:])

	// macOS is the exception: Finder passes no argument and sends an Apple Event
	// instead. This has to be set before the app runs, because it hooks the
	// moment the driver starts.
	shell.WatchOpenDocuments()

	w.ShowAndRun()
}
