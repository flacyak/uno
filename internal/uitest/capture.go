//go:build screenshot

// Package uitest drives the real uno binary under a live compositor and
// captures its window. It is behind the "screenshot" build tag because it needs
// a display, and the rest of the suite must keep passing without one (I-6).
package uitest

import (
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"os"
	"os/exec"
	"strings"
	"time"
)

// rect is a window's place on screen, in the compositor's coordinates.
type rect struct{ X, Y, W, H int }

// region renders the rectangle the way flameshot spells it.
func (r rect) region() string { return fmt.Sprintf("%dx%d+%d+%d", r.W, r.H, r.X, r.Y) }

// geom is how grim spells the same rectangle.
func (r rect) geom() string { return fmt.Sprintf("%d,%d %dx%d", r.X, r.Y, r.W, r.H) }

type hyprClient struct {
	Mapped bool   `json:"mapped"`
	At     [2]int `json:"at"`
	Size   [2]int `json:"size"`
	PID    int    `json:"pid"`
	Title  string `json:"title"`
}

// windowFor waits for the window belonging to a process and returns where it
// sits. Matching on the pid rather than on a window class or title is exact:
// it does not depend on what WM_CLASS Fyne happens to set, and it cannot pick
// up another uno window that was already open.
func windowFor(pid int, timeout time.Duration) (rect, error) {
	deadline := time.Now().Add(timeout)
	for {
		out, err := exec.Command("hyprctl", "clients", "-j").Output()
		if err != nil {
			return rect{}, fmt.Errorf("hyprctl clients: %w", err)
		}

		var clients []hyprClient
		if err := json.Unmarshal(out, &clients); err != nil {
			return rect{}, fmt.Errorf("parse hyprctl output: %w", err)
		}

		for _, c := range clients {
			if c.PID == pid && c.Mapped && c.Size[0] > 0 && c.Size[1] > 0 {
				return rect{c.At[0], c.At[1], c.Size[0], c.Size[1]}, nil
			}
		}

		if time.Now().After(deadline) {
			return rect{}, fmt.Errorf("no mapped window for pid %d within %s", pid, timeout)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// backend is one way to put a cropped PNG on disk.
type backend struct {
	name string
	args func(r rect, path string) []string
}

// backends are tried in order, first success wins. flameshot is the tool asked
// for; grim is the fallback because flameshot on wlroots goes through
// xdg-desktop-portal, which can decline or prompt, and a screenshot test that
// hangs on a portal dialog is worse than one that quietly used grim.
//
// Every one of them is given a region: the captures are of the uno window, never
// of the desktop behind it.
var backends = []backend{
	{"flameshot screen", func(r rect, p string) []string {
		// The only fully non-interactive flameshot subcommand taking --region:
		// "full" has no such option at all. It exits 2 with "Screenshot
		// aborted" under wlroots, where the portal declines it, so on those
		// sessions the next entry is what actually takes the picture.
		return []string{"flameshot", "screen", "--region", r.region(), "--path", p}
	}},
	{"flameshot gui", func(r rect, p string) []string {
		// --accept-on-select is what stops the selection overlay waiting for a
		// person, so a region given up front is captured and saved at once.
		return []string{"flameshot", "gui", "--region", r.region(),
			"--accept-on-select", "--path", p}
	}},
	{"grim", func(r rect, p string) []string {
		return []string{"grim", "-g", r.geom(), p}
	}},
}

// captureTimeout bounds each backend so a portal permission dialog cannot stall
// the suite; the next backend gets its turn instead.
const captureTimeout = 15 * time.Second

// capture crops a screenshot to r and writes it to path, reporting which tool
// produced it. A backend that exits cleanly but leaves no usable file counts as
// a failure, because that is exactly how a declined portal request looks.
func capture(r rect, path string) (string, error) {
	var attempts []string

	for _, b := range backends {
		if _, err := exec.LookPath(b.args(r, path)[0]); err != nil {
			attempts = append(attempts, b.name+": not installed")
			continue
		}
		_ = os.Remove(path)

		ctx, cancel := context.WithTimeout(context.Background(), captureTimeout)
		argv := b.args(r, path)
		out, err := exec.CommandContext(ctx, argv[0], argv[1:]...).CombinedOutput()
		cancel()

		if err != nil {
			attempts = append(attempts, fmt.Sprintf("%s: %v (%s)",
				b.name, err, strings.TrimSpace(string(out))))
			continue
		}
		if err := checkPNG(path, r); err != nil {
			attempts = append(attempts, fmt.Sprintf("%s: %v", b.name, err))
			continue
		}
		return b.name, nil
	}

	return "", fmt.Errorf("every capture backend failed:\n  %s",
		strings.Join(attempts, "\n  "))
}

// checkPNG is what separates a real capture from the black frame a declined
// portal request or a failed XWayland grab leaves behind. The size must match
// what was asked for, and the image must not be one flat colour.
func checkPNG(path string, r rect) error {
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("no file written: %w", err)
	}
	defer f.Close()

	img, err := png.Decode(f)
	if err != nil {
		return fmt.Errorf("not a readable PNG: %w", err)
	}

	// Compositors round window sizes, so allow a pixel or two either way while
	// still catching a full-desktop grab that ignored the region.
	b := img.Bounds()
	if abs(b.Dx()-r.W) > 2 || abs(b.Dy()-r.H) > 2 {
		return fmt.Errorf("captured %dx%d, want the %dx%d window region",
			b.Dx(), b.Dy(), r.W, r.H)
	}
	if uniform(img) {
		return fmt.Errorf("captured %dx%d of a single flat colour", b.Dx(), b.Dy())
	}
	return nil
}

// uniform reports whether every sampled pixel is the same colour, which is what
// a blank or black grab looks like. A real window has chrome, text and a grid.
func uniform(img image.Image) bool {
	b := img.Bounds()
	first := img.At(b.Min.X, b.Min.Y)
	for y := b.Min.Y; y < b.Max.Y; y += 7 { // a coprime stride avoids sampling
		for x := b.Min.X; x < b.Max.X; x += 7 { // only one column of pixels
			if img.At(x, y) != first {
				return false
			}
		}
	}
	return true
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
