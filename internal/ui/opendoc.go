package ui

// WatchOpenDocuments arranges for documents the desktop hands to uno to arrive
// in OpenPaths, which is the same door a drop and a command-line argument use.
//
// It exists because macOS is the one platform where that is not already true.
// Everywhere else the desktop passes paths in os.Args and main.go has already
// read them, so this does nothing; on macOS Finder passes nothing and sends an
// Apple Event instead, and opendoc_darwin.go answers it.
//
// Call this before the app runs: the darwin half installs its handler when the
// driver reports the app started, and that hook is only useful if it is set
// before the driver starts.
func (s *Shell) WatchOpenDocuments() {
	watchOpenDocuments(s.OpenPaths)
}
