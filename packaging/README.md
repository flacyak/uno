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

## macOS — not shipped, and why

macOS is the one platform where the declaration alone would not work, so there
is deliberately nothing here to install.

Finder does not pass a document as `argv`. It launches the application and sends
it a `kAEOpenDocuments` Apple Event, and an application that does not answer that
event simply opens. Fyne v2.8.1 installs no handler for it: there is no
`application:openFile:`, no `application:openURLs:`, and no Apple Event
machinery anywhere in the module.

So a `CFBundleDocumentTypes` entry would make Finder route `.uno` to uno, and uno
would come up showing an empty workspace. That is worse than no association at
all — the file looks broken rather than unregistered.

What it needs is an open-documents handler in the app bundle, which means an
Objective-C `NSApplicationDelegate` method reached through cgo, feeding the paths
into `Shell.OpenPaths` on the UI goroutine. That is a real piece of work and it
cannot be written blind: it needs a Mac to test on.
