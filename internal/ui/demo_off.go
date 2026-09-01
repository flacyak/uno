//go:build !demo

package ui

// startDemo does nothing in a shipped build. The scripted preview in demo.go is
// a filming rig for docs/preview.gif and has no business in the binary a person
// installs, so the tag that builds it is off by default and this is what NewShell
// calls instead.
func (s *Shell) startDemo() {}
