//go:build !darwin || !cgo

package ui

// watchOpenDocuments does nothing off macOS, where the desktop opens a document
// by passing its path to the process and main.go has already read it.
//
// The !cgo half of the constraint matters for cross-compilation: a darwin build
// with cgo disabled cannot carry the Objective-C handler, and it should still
// build rather than fail to find this function.
func watchOpenDocuments(func([]string)) {}
