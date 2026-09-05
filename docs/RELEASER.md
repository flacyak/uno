# Release automation

A git tag is the single source of truth for `uno`'s version. Pushing `v0.0.1` builds the
app for Linux, macOS and Windows, packages each the way its platform expects, signs the
macOS bundle, and attaches everything to a GitHub Release with checksums and a changelog.
Module publishing to pkg.go.dev stays out of scope.

## Design

`uno` is a Fyne GUI app, so every desktop binary needs `CGO_ENABLED=1` and, more to the
point, the platform's GUI toolchain. A C compiler alone is not enough — what each target
wants is visible in the cgo directives of `go-gl/glfw` and of `internal/ui/opendoc_darwin.go`:

- **Linux** links the X11 stack (`X11`, `Xrandr`, `Xxf86vm`, `Xi`, `Xcursor`, `Xinerama`
  and their transitive `xcb`/`Xau`/`Xdmcp`/`Xext`/`Xfixes`/`Xrender`), the Wayland stack
  (`wayland-client`, `wayland-cursor`, `wayland-egl`, `xkbcommon`) and GL — twenty-three
  shared libraries in all. Nothing sets an `x11` or `wayland` build tag, so GLFW takes its
  `linux,!x11,!wayland` branch and both backends are linked.
- **Windows** wants `-D_GLFW_WIN32` with GLFW's vendored mingw headers, and links `gdi32`
  and `opengl32` — mingw-w64 import libraries.
- **macOS** wants `-framework Cocoa -framework IOKit -framework CoreVideo` and
  `-framework OpenGL`, compiled `-x objective-c`, plus the `Cocoa` framework for this
  repository's own `opendoc_darwin.m`. That is a vendor SDK requirement, not a libc one.

`fyne-cross` is what supplies all three. Its container images already carry the sysroots,
it drives `fyne package` so the output is a real `.app` bundle and a real `.exe`, and it
reads the `ID`, `Version` and `LinuxAndBSD` metadata already declared in `FyneApp.toml`.
Linux `arm64` comes along without a hand-built sysroot.

The whole release therefore runs on one `ubuntu-latest` job. One runner means one process
creating the release, so there is no ordering to arrange and no checksum file to
disambiguate.

## 1. `main.go`

The linker target sits alongside `package main`:

```go
// Set by the linker at release time; see .github/workflows/release.yml.
var version = "dev"
```

`FyneApp.toml` keeps `Version = "0.2.0"`. It feeds `fyne package`, which is what stamps the
bundle metadata; the `-X` injection is what stamps the binary.

## 2. The macOS SDK

Cross-compiling to darwin needs Apple's SDK, which cannot be redistributed. `fyne-cross`
extracts it from the official Command Line Tools for Xcode 12.5.1 disk image, downloaded
under your own Apple ID:

```
fyne-cross darwin-sdk-extract --xcode-path /path/to/Command_Line_Tools_for_Xcode_12.5.1.dmg
```

That yields `SDKs/MacOSX11.3.sdk`, which is the version `fyne-cross` supports and which
covers Apple Silicon — arm64 arrived with macOS 11.0. Read the Xcode license terms before
running it.

The disk image needs an Apple ID, so CI cannot fetch it. Extract once locally and prime a
GitHub Actions cache keyed on the SDK version; the workflow restores from that cache and
skips the darwin leg when the cache is cold rather than failing the whole release.

A cache entry can only be written from inside Actions, so priming it means one
`workflow_dispatch` run that uploads the extracted `SDKs/` directory. Actions then evicts
that entry after 7 days without a hit. Because a cold cache skips darwin rather than
failing, **a release cut after a quiet week ships no macOS artifacts** — the workflow logs a
`::warning` when this happens, and that warning is the thing to check before announcing a
release.

## 3. Building

Every leg runs `fyne package`, which requires an application icon: it falls back to
`Icon.png` beside the source and fails with `Missing application icon` if that is absent
(`cmd/fyne/internal/commands/package.go:368`). So the repository needs an `Icon.png` at its
root — square, and at least 512×512 so the `.icns` macOS gets is usable — declared as
`Icon = "Icon.png"` under `[Details]` in `FyneApp.toml`. Declaring it in the metadata rather
than passing `-icon` per invocation is what also puts it on the generated `.desktop` entry.

```
fyne-cross linux   --arch=amd64,arm64 -app-id io.uno.app
fyne-cross windows --arch=amd64       -app-id io.uno.app
fyne-cross darwin  --arch=amd64,arm64 -app-id io.uno.app \
  --macosx-sdk-path "$SDK_DIR/MacOSX11.3.sdk"
```

Output lands under `fyne-cross/dist/<os>-<arch>/`. The tag reaches the binary through
`-ldflags "-X main.version=$TAG"`.

## 4. Document types

`fyne package -os darwin` renders its own `Info.plist` and overwrites whatever was there,
so the `.uno` declaration goes in afterwards. `packaging/darwin/document-types.plist` holds
the `CFBundleDocumentTypes` and `UTExportedTypeDeclarations` keys; the workflow merges them
into the packaged bundle's `Info.plist` with Python's `plistlib`, which is the same merge
`packaging/darwin/associate.sh` performs with `PlistBuddy` on a Mac. Baking the keys in at
build time means a released bundle needs no `associate.sh` run to be recognised as the
handler for `.uno`.

## 5. Signing the bundle

macOS on Apple Silicon will not execute an unsigned arm64 binary. Go's linker encodes the
same rule — `NeedCodeSign` is `IsDarwin() && IsARM64()` — but skips signing whenever the
link is external, and cgo makes every link external. So the signature is applied
explicitly, with `rcodesign` from `indygreg/apple-platform-rs`, which ships a static
`x86_64-unknown-linux-musl` binary and needs neither Docker nor a Mac:

```
rcodesign sign fyne-cross/dist/darwin-arm64/uno.app
rcodesign sign fyne-cross/dist/darwin-amd64/uno.app
```

With no certificate supplied, `sign` produces an ad-hoc signature. It traverses the bundle
on its own: nested Mach-O binaries are signed, `CodeResources` is computed, and the
identity comes from the bundle's `CFBundleIdentifier` — `io.uno.app`, by way of
`FyneApp.toml`. x86_64 macOS still runs unsigned code, so the amd64 bundle is signed for
consistency rather than necessity.

**Signing comes last.** It digests the `Info.plist` and every resource, so the merge in
step 4 has to be complete first; editing the bundle afterwards invalidates the signature,
and an invalid signature on arm64 is a bundle that will not launch. The order is: package,
merge, sign, archive.

An ad-hoc signature gets the app to run. It does not satisfy Gatekeeper for a downloaded
app — that needs notarization, and until then a first launch goes through right-click →
Open.

## 6. Publishing

GoReleaser handles the release itself and nothing else: the changelog and the upload.
Builds are disabled, and the artifacts `fyne-cross` produced are attached through
`release.extra_files`.

Checksums are the one thing GoReleaser cannot do here. Its checksum pipe only covers
artifacts it built itself, so with `builds` disabled it runs and writes nothing — verified
by a `release --skip=publish` run against a config in this shape, which produced no
`checksums.txt`. The workflow therefore `sha256sum`s the assembled directory itself, and the
result uploads as one more extra file.

The workflow also assembles every artifact into one flat `release-artifacts/` directory
under its final name. Globbing that rather than `fyne-cross/dist/<os>-<arch>/` is what lets
the darwin leg be skipped without failing the release on a glob that matches nothing.

```yaml
version: 2
project_name: uno

builds:
  - skip: true

checksum:
  disable: true

release:
  draft: false
  prerelease: auto
  extra_files:
    - glob: release-artifacts/*

changelog:
  sort: asc
  use: github
  filters:
    exclude: ['^docs:', '^test:', '^chore:', '^ci:']
```

## 7. `.github/workflows/release.yml`

Triggered on `v*` tags, `permissions: contents: write`, a single `ubuntu-latest` runner —
Docker is present on the image, which is what `fyne-cross` needs. Go comes from
`go-version-file: go.mod`, so the toolchain tracks the module rather than a pinned string
that can drift behind it. The steps are: checkout at `fetch-depth: 0` so the changelog has
history, restore the SDK cache, install `fyne-cross` and a pinned `rcodesign`, build,
merge, sign, then GoReleaser.

## Verification

Local and non-publishing:

1. `fyne-cross linux --arch=amd64` exercises the toolchain and the container path.
2. Parsing the merged `Info.plist` with `plistlib` confirms `CFBundleDocumentTypes` and the
   `io.uno.workspace` UTI survived the merge.
3. `rcodesign print-signature-info uno.app` shows a CodeDirectory naming `io.uno.app` and a
   computed `CodeResources`. Running it after the merge is what catches a resequenced
   pipeline.
4. `goreleaser check` validates the config against the v2 schema — schema only, so a pass is
   necessary and not sufficient: it accepted an earlier config whose `{{ .uno }}` template
   variable does not exist. `goreleaser release --skip=publish` is what exercises the
   templates and the artifact globs.
5. `CGO_ENABLED=0 go test ./internal/...` passes; the six `internal/...` packages are pure
   Go.

On a Mac, which is the part no Linux check reaches: the `.app` launches from Finder, and a
double-clicked `.uno` opens in it.

## Cutting the release

The tag lands on a commit that is on `main` and pushed to `origin`:

```
git tag -a v0.0.1 -m "v0.0.1"
git push origin v0.0.1
```

## Follow-ups

- Notarize the macOS bundles with an Apple Developer ID so Gatekeeper accepts a downloaded
  copy. `rcodesign` covers this with `notary-submit`, `notary-wait` and `staple`.
- Windows `arm64`, once mingw-w64 support for it is worth relying on.
- Add a `LICENSE` file and ship it inside each archive.
