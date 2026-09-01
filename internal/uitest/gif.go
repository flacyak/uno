//go:build screenshot

package uitest

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// This file turns the scripted preview in internal/ui/demo.go into
// docs/preview.gif: film the window while the script plays, then encode what
// was filmed.

// frameRate is what the GIF is resampled to. Twelve is enough for a caret and a
// scroll to look continuous, and low enough that ten seconds of a mostly still
// window stays a file worth putting in a README.
const frameRate = 12

// frameInterval is how often the recorder tries to grab. It is faster than
// frameRate so the encoder is resampling a surplus rather than interpolating a
// shortfall, which is what keeps a slow grab from showing up as a stutter.
const frameInterval = 60 * time.Millisecond

// previewWidth caps the encoded width. The window is filmed at its real
// 1100x720 and scaled here, because scaling once at the end is sharper than
// filming small, and because a README column is narrower than a window.
const previewWidth = 1100

// frame is one captured PNG and when, into the recording, it was taken.
type frame struct {
	path string
	at   time.Duration
}

// record grabs the window region every frameInterval for d, returning what it
// caught and when.
//
// grim is used directly rather than through capture: capture tries flameshot
// first and gives each backend fifteen seconds to fail, which is the right
// trade for one still and quite wrong two hundred times in a row.
//
// The timestamps are kept rather than assumed, because a grab takes as long as
// it takes. Timing every frame from a counter would smear the wait before a
// keystroke into the keystroke itself; timing them from the clock lets the
// encoder put each frame back where it actually happened.
//
// rolling is called once the first frame is on disk, which is the moment the
// script may begin: filming has not started until something has been filmed.
func record(r rect, dir string, d time.Duration, rolling func()) ([]frame, error) {
	if _, err := exec.LookPath("grim"); err != nil {
		return nil, fmt.Errorf("grim is what films the preview: %w", err)
	}

	var frames []frame
	start := time.Now()

	for i := 0; ; i++ {
		at := time.Since(start)
		if at >= d {
			return frames, nil
		}

		path := filepath.Join(dir, fmt.Sprintf("frame-%05d.png", i))
		out, err := exec.Command("grim", "-g", r.geom(), path).CombinedOutput()
		if err != nil {
			return nil, fmt.Errorf("grim frame %d: %w (%s)",
				i, err, strings.TrimSpace(string(out)))
		}
		frames = append(frames, frame{path: path, at: at})
		if i == 0 && rolling != nil {
			rolling()
		}

		if rest := frameInterval - (time.Since(start) - at); rest > 0 {
			time.Sleep(rest)
		}
	}
}

// playlist writes the frames as an ffconcat script, each holding until the next
// one was taken. This is what carries the recorder's real timing into the
// encoder; handing ffmpeg a directory of PNGs instead would assert they were
// evenly spaced, and they are not.
func playlist(frames []frame, total time.Duration, path string) error {
	var b strings.Builder
	b.WriteString("ffconcat version 1.0\n")

	for i, f := range frames {
		end := total
		if i+1 < len(frames) {
			end = frames[i+1].at
		}
		fmt.Fprintf(&b, "file %s\nduration %.4f\n", f.path, (end - f.at).Seconds())
	}

	// The concat demuxer reads a duration as the gap before the next entry, so
	// the last frame needs one more mention to be held rather than flashed.
	if n := len(frames); n > 0 {
		fmt.Fprintf(&b, "file %s\n", frames[n-1].path)
	}
	return os.WriteFile(path, []byte(b.String()), 0o644)
}

// encode turns the playlist into a looping GIF.
//
// The palette is generated from the recording itself in the same pass that uses
// it: 256 colours chosen from these frames rather than from a fixed web palette
// is the difference between readable 12px text and a dithered mess. stats_mode
// and diff_mode both say the same thing about this footage — that most of the
// window is unchanged most of the time — so the palette is spent on what moves,
// and only the rectangle that moved is rewritten in each frame.
func encode(list, out string) error {
	filter := fmt.Sprintf(
		"fps=%d,scale=w=min(%d\\,iw):h=-1:flags=lanczos,split[a][b];"+
			"[a]palettegen=stats_mode=diff[p];"+
			"[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle",
		frameRate, previewWidth)

	cmd := exec.Command("ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
		"-f", "concat", "-safe", "0", "-i", list,
		"-filter_complex", filter, "-loop", "0", out)

	if o, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("ffmpeg: %w\n%s", err, o)
	}
	return nil
}

// distinct counts how many of the frames differ from one another.
//
// It is the check that separates a recording of the app from a recording of a
// window that never woke up. Every other failure mode here is loud — grim
// errors, ffmpeg errors — but a script that silently did nothing produces two
// hundred identical frames and a perfectly valid GIF of a still image.
func distinct(frames []frame) (int, error) {
	seen := map[[32]byte]bool{}
	for _, f := range frames {
		b, err := os.ReadFile(f.path)
		if err != nil {
			return 0, err
		}
		seen[sha256.Sum256(b)] = true
	}
	return len(seen), nil
}

// differ reports whether two frames are not the same image, which is how the
// recording is checked to have covered the story rather than one beat of it.
func differ(a, b frame) (bool, error) {
	x, err := os.ReadFile(a.path)
	if err != nil {
		return false, err
	}
	y, err := os.ReadFile(b.path)
	if err != nil {
		return false, err
	}
	return !bytes.Equal(x, y), nil
}
