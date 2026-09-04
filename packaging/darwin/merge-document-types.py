#!/usr/bin/env python3
"""Merges the .uno type declaration into a packaged uno.app's Info.plist.

This is what associate.sh does with PlistBuddy, done with plistlib so it can run
off a Mac. The release workflow builds the darwin bundles in a Linux container,
where /usr/libexec/PlistBuddy does not exist; doing the merge at build time is
what makes a released bundle the handler for .uno without the user running
associate.sh at all.

    ./merge-document-types.py uno.app [uno.app ...]

Idempotent: the keys are replaced, not appended to, so a second run over the same
bundle leaves it as the first run did. That is the same reason associate.sh
deletes before merging.

`fyne package -os darwin` renders its own Info.plist over whatever was there on
every run, so this has to happen after packaging -- and, because rcodesign
digests the Info.plist, before signing.
"""

import plistlib
import sys
from pathlib import Path

# The keys the fragment contributes, and so the keys a re-run must clear first.
# Kept in step with the KEYS array in associate.sh.
KEYS = ("UTExportedTypeDeclarations", "CFBundleDocumentTypes")

FRAGMENT = Path(__file__).resolve().parent / "document-types.plist"


def merge(app: Path) -> None:
    info = app / "Contents" / "Info.plist"
    if not info.is_file():
        # Merging into a path that does not exist yet would write a plist
        # describing no application, which is the failure associate.sh guards
        # against too.
        sys.exit(f"{app} has no Contents/Info.plist, so it is not an application bundle")

    with FRAGMENT.open("rb") as f:
        fragment = plistlib.load(f)
    with info.open("rb") as f:
        plist = plistlib.load(f)

    for key in KEYS:
        plist.pop(key, None)
    plist.update({key: fragment[key] for key in KEYS})

    with info.open("wb") as f:
        plistlib.dump(plist, f)

    uti = plist["UTExportedTypeDeclarations"][0]["UTTypeIdentifier"]
    print(f"merged {uti} into {info}")


def main(argv: list[str]) -> None:
    if not argv:
        sys.exit("usage: merge-document-types.py uno.app [uno.app ...]")
    for arg in argv:
        merge(Path(arg))


if __name__ == "__main__":
    main(sys.argv[1:])
