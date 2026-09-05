// Main package wiring //internal to a window shell.
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
	a := app.NewWithID("io.uno.app")

	w := a.NewWindow("uno")
	shell := ui.NewShell(w)

	w.SetContent(shell.Content())
	w.Resize(fyne.NewSize(ui.WindowWidth, ui.WindowHeight))
	w.CenterOnScreen()

	// open files on command line
	shell.OpenPaths(os.Args[1:])

	// OSX need Apple Event instead. Need a hook the moment the driver starts
	shell.WatchOpenDocuments()

	w.ShowAndRun()
}
