package safefile

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestWritePublishesWhatTheCallbackWrote(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sales-q3.uno")

	if err := Write(path, func(w io.Writer) error {
		_, err := io.WriteString(w, "hello")
		return err
	}); err != nil {
		t.Fatalf("write: %v", err)
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(got) != "hello" {
		t.Errorf("contents = %q, want %q", got, "hello")
	}
}

// The file is an ordinary user file, not the 0600 the temp it was built from
// starts life as. A save that quietly made someone's document unreadable to
// their own group would be a decision this package is not entitled to make.
func TestTheWrittenFileIsNotPrivateToTheTempItCameFrom(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sales-q3.uno")

	if err := Write(path, func(io.Writer) error { return nil }); err != nil {
		t.Fatalf("write: %v", err)
	}

	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if got := fi.Mode().Perm(); got != 0o644 {
		t.Errorf("mode = %04o, want 0644", got)
	}
}

// A write that cannot be completed must leave nothing behind, so the directory
// beside a good file never fills with half-written parts.
func TestAFailedWriteLeavesNoDebris(t *testing.T) {
	dir := t.TempDir()

	err := Write(filepath.Join(dir, "sales-q3.uno"), func(w io.Writer) error {
		io.WriteString(w, "half of something") // written, and never published
		return errors.New("no")
	})
	if err == nil {
		t.Fatal("want a failure, got nil")
	}

	left, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	for _, e := range left {
		t.Errorf("left behind %q", e.Name())
	}
}

// An interrupted write must lose the new content rather than the content already
// there, which is the whole reason this package exists.
func TestAFailedWriteLeavesThePreviousOneWhole(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sales-q3.uno")
	if err := os.WriteFile(path, []byte("the saved one"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	err := Write(path, func(w io.Writer) error {
		io.WriteString(w, "the new one")
		return errors.New("no")
	})
	if err == nil {
		t.Fatal("want a failure, got nil")
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("the previous write is gone: %v", err)
	}
	if string(got) != "the saved one" {
		t.Errorf("contents = %q, want the previous write", got)
	}
}
