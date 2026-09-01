# packaging

Registering `.uno` with the desktop, so double-clicking one opens uno.

The application code needs nothing for this: `main.go` already passes
`os.Args[1:]` to `Shell.OpenPaths`, which is the same door a drop uses. What is
here is the declaration each platform wants, and a script to install it.

`fyne package` cannot express any of it. Its metadata struct
(`internal/metadata.AppDetails`) carries only an icon, a name, an ID, a version
and a build number; its Linux `.desktop` template has no `MimeType` line, and
its `Info.plist` template has no `CFBundleDocumentTypes` key and is overwritten
on every package. The `[[Details.Extensions]]` block that turns up in write-ups
of this kind is not a field Fyne reads — TOML decoding drops unknown keys
silently, so adding one registers nothing and reports no error.

The type is `application/vnd.uno.workspace+zip` and the extension is `.uno`
everywhere. A file written on one platform is opened on another, so the name it
travels under has to be the same on all of them.

## Linux and BSD — `linux/associate.sh`

```
packaging/linux/associate.sh install      # builds into ~/.local/bin and registers
packaging/linux/associate.sh verify
packaging/linux/associate.sh uninstall
```

Installs under `~/.local/share`, so it needs no root: an association is a
statement about what one person wants opened with what.

`io.uno.app.xml` defines the type for the shared MIME database. It declares
`.uno` a subclass of `application/zip`, which it is, so a file manager that has
never heard of uno can still say it is an archive. It also carries a magic rule
matching a zip header whose first entry is named `uno.json`, which every
container uno writes begins with, so a `.uno` that lost its extension is still
recognised.

`io.uno.app.desktop` is the entry. It lists `text/csv` and
`text/tab-separated-values` alongside uno's own type so uno appears in "Open
With" for them; the script claims the *default* only for
`application/vnd.uno.workspace+zip`, because taking CSV away from whatever a
person already uses is not a script's decision.

Verified on this machine: `gio` reports both a named and an extension-less
container as `application/vnd.uno.workspace+zip`, `xdg-mime query default`
returns `io.uno.app.desktop`, and `gio open` — which is what a GTK file manager
runs on a double-click — launches uno with the path and the workspace loads.

## Windows — `windows/associate.ps1`

```
packaging\windows\associate.ps1
packaging\windows\associate.ps1 -Action uninstall
```

Writes under `HKCU\Software\Classes`, the per-user half of the class registry:
no administrator, no effect on anyone else, and it outranks a machine-wide
association for this user. Windows passes the document as an argument, so
`os.Args` receives it exactly as on Linux.

Not verified — there is no Windows machine in this repository's development
loop. The registry keys are the standard ones and the script reads them back
after writing, but nobody has double-clicked a `.uno` in Explorer.

## macOS — `darwin/associate.sh`

```
packaging/darwin/associate.sh install [uno.app]     default: ./uno.app
packaging/darwin/associate.sh verify  [uno.app]
packaging/darwin/associate.sh uninstall [uno.app]
```

`document-types.plist` holds the two keys macOS wants: a
`UTExportedTypeDeclarations` entry defining `io.uno.workspace`, and a
`CFBundleDocumentTypes` entry claiming `LSHandlerRank: Owner` over it. The type
conforms to `com.pkware.zip-archive`, which is the same statement the Linux
declaration makes with `<sub-class-of type="application/zip"/>`, and its tag
specification carries both the `uno` extension and the media type the other two
platforms register.

It is a fragment rather than a complete `Info.plist` because `fyne package -os
darwin` creates that file and renders its own template over it on every run, so
a copy of ours would last until the next package. `associate.sh` merges the keys
into a bundle afterwards with `PlistBuddy`, deleting them first so a second
install replaces the declaration rather than appending to the same arrays.

The script checks two separate things, because they can disagree and the
difference is the whole story here. `plutil -extract` reads the declaration back
out of the bundle: that is what uno controls, and it is either right or it is a
bug. `mdls -name kMDItemContentType` reports what a real `.uno` is taken for:
that is what the system believes, and it is allowed to lag. Launch Services does
not watch for a changed `Info.plist`, so the script nudges it with `lsregister
-f` and, if the type has not landed yet, prints the database rebuild to run. A
declaration that is correct but not yet registered is a wait, not a failure.

### The Apple Event, and why there is Objective-C in internal/ui

Finder does not pass a document as `argv`. It launches the application and sends
it a `kAEOpenDocuments` Apple Event, so the type declaration alone would put uno
on screen with an empty workspace.

Fyne v2.8.1 answers no such event, and neither does GLFW: `GLFWApplicationDelegate`
implements `applicationShouldTerminate`, `applicationDidChangeScreenParameters`,
`applicationWillFinishLaunching`, `applicationDidFinishLaunching` and
`applicationDidHide`, and nothing else (`glfw/src/cocoa_init.m:397`). NSApplication's
own handler for the event calls a delegate method that is not there, and the
event is swallowed.

`internal/ui/opendoc_darwin.m` registers a handler with `NSAppleEventManager`
that replaces it, and hands each path to Go, which queues it onto the UI
goroutine with `fyne.Do` and into `OpenPaths` — the same door a drop uses.

Timing is the difficulty. Registering before AppKit finishes launching loses,
because AppKit installs its handler afterwards; registering after the event has
been dispatched loses the file that started the app. The hook in between is
Fyne's `Lifecycle().SetOnStarted`, which the driver fires once GLFW has
initialised and immediately before the event loop begins ticking
(`internal/driver/glfw/loop.go:128`). That is where the handler goes in.

### What is verified, and what is not

Checked here, on Linux: the fragment parses as a plist and holds the expected
UTI, extension, media type and handler rank; merging it into the `Info.plist`
that `fyne package -os darwin` actually renders produces a plist that still
parses and keeps all thirteen of Fyne's own keys; the build constraints select
`opendoc_darwin.go` and `opendoc_darwin.m` on `darwin && cgo` and the no-op stub
everywhere else, with no duplicate definition; the extension and media type match
the Linux and Windows declarations exactly.

Not checked: anything needing a Mac. The Objective-C has never been compiled —
that needs the macOS SDK — and `PlistBuddy`, `plutil`, `lsregister` and `mdls`
are all macOS-only, so `associate.sh` has never run past its platform check.
Nobody has double-clicked a `.uno` in Finder.

The likeliest thing to need adjusting on a real Mac is the handler's timing. If
the document that launched uno is missed while a later `open file.uno` works,
the event is being dispatched before `OnStarted`, and the fix is to add
`application:openFiles:` to the live delegate class instead of replacing the
event handler.
