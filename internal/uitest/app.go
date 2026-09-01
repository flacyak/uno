//go:build screenshot

package uitest

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// paintSettle is how long the window is given to finish its first frame after
// the compositor reports it mapped. Capturing a mapped-but-unpainted window is
// how a screenshot test produces a convincing-looking blank.
const paintSettle = 900 * time.Millisecond

// repoRoot is the directory holding go.mod, which is where testdata lives.
func repoRoot(t *testing.T) string {
	t.Helper()
	out, err := exec.Command("go", "list", "-m", "-f", "{{.Dir}}").Output()
	if err != nil {
		t.Fatalf("locate module root: %v", err)
	}
	return string(trimNewline(out))
}

func trimNewline(b []byte) []byte {
	for len(b) > 0 && (b[len(b)-1] == '\n' || b[len(b)-1] == '\r') {
		b = b[:len(b)-1]
	}
	return b
}

// build compiles the real binary once per run. The screenshots are of the
// program a person would launch, not of a test harness pretending to be it.
func build(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "uno")

	cmd := exec.Command("go", "build", "-o", bin, ".")
	cmd.Dir = repoRoot(t)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	return bin
}

// launch starts uno and waits until its window is mapped and painted, returning
// where that window sits. The process is killed when the test ends.
func launch(t *testing.T, bin string, args ...string) rect {
	t.Helper()

	cmd := exec.Command(bin, args...)
	cmd.Dir = repoRoot(t)
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("start uno: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	})

	r, err := windowFor(cmd.Process.Pid, 20*time.Second)
	if err != nil {
		t.Fatalf("waiting for the uno window: %v", err)
	}
	time.Sleep(paintSettle)
	return r
}

// shot captures the window and records which backend managed it, so a run that
// silently fell back to grim says so rather than looking like a flameshot pass.
func shot(t *testing.T, r rect, name string) string {
	t.Helper()

	dir := filepath.Join(repoRoot(t), ".screenshots")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("make screenshot dir: %v", err)
	}
	path := filepath.Join(dir, name)

	backend, err := capture(r, path)
	if err != nil {
		t.Fatalf("capture %s: %v", name, err)
	}
	t.Logf("%s: %s captured %dx%d at %d,%d", name, backend, r.W, r.H, r.X, r.Y)
	return path
}
