//go:build screenshot

package uitest

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// paintSettle is how long the window is given to finish its first frame after
// the compositor reports it mapped. Capturing a mapped-but-unpainted window is
// how a screenshot test produces a convincing-looking blank.
const paintSettle = 900 * time.Millisecond

// floatSettle is how long the float dispatch is given to finish. Hyprland
// animates the move out of the tile, and reading the geometry mid-animation
// returns a rectangle the window is only passing through.
const floatSettle = 500 * time.Millisecond

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
//
// Tags are passed through for the preview recording, which needs the scripted
// build. Everything else asks for none and gets the shipped one.
func build(t *testing.T, tags ...string) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "uno")

	args := []string{"build", "-o", bin}
	if len(tags) > 0 {
		args = append(args, "-tags", strings.Join(tags, ","))
	}
	cmd := exec.Command("go", append(args, ".")...)
	cmd.Dir = repoRoot(t)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	return bin
}

// launch starts uno and waits until its window is mapped and painted, returning
// where that window sits. The process is killed when the test ends.
//
// The window is floated on the way, so what is captured is the 1100x720 main.go
// asks for rather than whatever slot the compositor's layout had free. Under a
// tiling WM a captured size is otherwise a fact about the desktop the run
// happened on, and two machines produce differently cropped artefacts from the
// same code.
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

	if err := float(cmd.Process.Pid); err != nil {
		t.Fatalf("floating the uno window: %v", err)
	}
	// Floating moves and resizes the window, so where it sits has to be read
	// again; the first answer described the tile it has just left.
	if r, err = windowFor(cmd.Process.Pid, 5*time.Second); err != nil {
		t.Fatalf("waiting for the floated uno window: %v", err)
	}

	time.Sleep(paintSettle)
	return r
}

// float asks Hyprland to unfloat the window from its tile. A floating window
// keeps the size its client asked for, which is what makes 1100x720 the size on
// disk without this having to name a number of its own.
//
// hyprctl answers "ok" whether or not the selector matched anything, so nothing
// is read from it: the geometry re-read afterwards is what proves it worked.
func float(pid int) error {
	dispatch := fmt.Sprintf("hl.dsp.window.float(%q)", fmt.Sprintf("pid:%d", pid))
	out, err := exec.Command("hyprctl", "dispatch", dispatch).CombinedOutput()
	if err != nil {
		return fmt.Errorf("hyprctl dispatch: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	time.Sleep(floatSettle)
	return nil
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
