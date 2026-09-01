//go:build darwin && cgo

package ui

/*
#cgo LDFLAGS: -framework Cocoa

void unoInstallOpenDocumentsHandler(void);
*/
import "C"

import (
	"sync"

	"fyne.io/fyne/v2"
)

// opened is the handler the Apple Event callback reaches. It is written once
// before the app runs and read from whichever thread AppKit dispatches on, so
// it is guarded rather than left to chance.
var opened struct {
	sync.Mutex
	open func([]string)
}

// unoOpenDocument is called once per file by the Objective-C handler.
//
// Finder can deliver several paths in one event, and each arrives here
// separately rather than as a batch. That is the same shape as a multi-file
// drop, which openAll already turns into one workspace per file.
//
//export unoOpenDocument
func unoOpenDocument(path *C.char) {
	p := C.GoString(path)

	opened.Lock()
	open := opened.open
	opened.Unlock()

	if open == nil {
		return // nothing is listening yet, and there is nowhere to put a file
	}

	// AppKit calls this on the main thread, which is not the same thing as
	// being on Fyne's UI goroutine. fyne.Do queues the work for the goroutine
	// that is allowed to touch a sheet (I-7); it does not block, and unlike
	// DoAndWait it is safe to call from the main thread.
	fyne.Do(func() { open([]string{p}) })
}

func watchOpenDocuments(open func([]string)) {
	opened.Lock()
	opened.open = open
	opened.Unlock()

	// Timing is the whole difficulty here, and this hook is the reason it works.
	//
	// NSApplication installs its own kAEOpenDocuments handler while it finishes
	// launching, and that handler calls a delegate method GLFW does not
	// implement — its delegate has applicationShouldTerminate,
	// applicationDidFinishLaunching and three others, and no openFile at all
	// (glfw/src/cocoa_init.m:397). So the launch event is swallowed unless
	// something replaces that handler.
	//
	// Replacing it too early loses to AppKit, which installs its own afterwards.
	// Replacing it too late loses the event that launched the app. OnStarted is
	// the window in between: the driver fires it after GLFW has initialised and
	// immediately before the event loop begins ticking (glfw/loop.go:128).
	fyne.CurrentApp().Lifecycle().SetOnStarted(func() {
		C.unoInstallOpenDocumentsHandler()
	})
}
