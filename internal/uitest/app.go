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

	"github.com/flacyak/uno/internal/ui"
)

// paintSettle is how long the window is given to finish its first frame after
// the compositor reports it mapped. Capturing a mapped-but-unpainted window is
// how a screenshot test produces a convincing-looking blank.
const paintSettle = 900 * time.Millisecond

// floatSettle is how long the float and resize dispatches are given to finish.
// Hyprland animates both, and reading the geometry mid-animation returns a
// rectangle the window is only passing through.
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
// The window is reframed on the way, so what is captured is the size main.go
// asks for rather than whatever slot the compositor's layout had free.
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

	if err := reframe(cmd.Process.Pid); err != nil {
		t.Fatalf("framing the uno window: %v", err)
	}
	// Framing moves and resizes the window, so where it sits has to be read
	// again; the first answer described the tile it has just left.
	if r, err = windowFor(cmd.Process.Pid, 5*time.Second); err != nil {
		t.Fatalf("waiting for the framed uno window: %v", err)
	}

	time.Sleep(paintSettle)
	return r
}

// reframe lifts the window out of its tile and gives it the size uno asks for, so
// what is captured is the same rectangle on every machine.
//
// Floating is not enough on its own. Hyprland hands a window out of its tile at
// whatever size the tile had, so a captured size would be a fact about the
// desktop the run happened on, and two machines would produce differently
// cropped artefacts from the same code. Naming the rectangle — the one main.go
// asks for, read from the same constants it uses — is what makes it reproducible.
//
// hyprctl answers "ok" whether or not the selector matched anything, so nothing
// is read from it: the geometry re-read afterwards is what proves it worked.
func reframe(pid int) error {
	sel := fmt.Sprintf("pid:%d", pid)
	if err := dispatch(fmt.Sprintf("hl.dsp.window.float(%q)", sel)); err != nil {
		return err
	}
	if err := dispatch(fmt.Sprintf("hl.dsp.window.resize({x=%d,y=%d,window=%q})",
		ui.WindowWidth, ui.WindowHeight, sel)); err != nil {
		return err
	}

	time.Sleep(floatSettle)
	return nil
}

// dispatch runs one Hyprland dispatcher. A dispatcher it does not recognise, or
// arguments it cannot parse, come back as a non-zero exit rather than as a quiet
// no-op, which is what lets a compositor upgrade break the rig loudly.
func dispatch(cmd string) error {
	out, err := exec.Command("hyprctl", "dispatch", cmd).CombinedOutput()
	if err != nil {
		return fmt.Errorf("hyprctl dispatch %s: %w (%s)",
			cmd, err, strings.TrimSpace(string(out)))
	}
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
