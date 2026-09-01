#!/usr/bin/env bash
#
# Registers .uno with the desktop, so double-clicking one opens uno.
#
# Everything is installed under the user's own data directory. Nothing here
# needs root, and nothing here touches a system path: a file association is a
# statement about what this person wants opened with what, and that is where the
# XDG specification says it belongs.
#
#   ./associate.sh install [binary]   default: builds the module into ~/.local/bin
#   ./associate.sh uninstall
#
set -euo pipefail

readonly MIME=application/vnd.uno.workspace+zip
readonly ID=io.uno.app

readonly here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly data="${XDG_DATA_HOME:-$HOME/.local/share}"
readonly mimedir="$data/mime/packages"
readonly appsdir="$data/applications"
readonly bindir="${HOME}/.local/bin"

die() { echo "associate.sh: $*" >&2; exit 1; }

need() {
    command -v "$1" >/dev/null 2>&1 ||
        die "$1 is not installed; it comes with shared-mime-info and desktop-file-utils"
}

# refresh rebuilds the two caches the desktop reads. Neither the MIME database
# nor the application index is consulted from the source files directly, so
# skipping this leaves everything installed and nothing working.
refresh() {
    update-mime-database "$data/mime"
    update-desktop-database "$appsdir"
}

install_association() {
    local exe="${1:-}"

    if [ -z "$exe" ]; then
        # Build from the module this script sits in, so the association points
        # at the uno being worked on rather than at whatever is on PATH.
        mkdir -p "$bindir"
        exe="$bindir/uno"
        echo "building $exe"
        (cd "$here/../.." && go build -o "$exe" .)
    fi

    exe="$(cd "$(dirname "$exe")" && pwd)/$(basename "$exe")"
    [ -x "$exe" ] || die "$exe is not an executable"

    mkdir -p "$mimedir" "$appsdir"
    cp "$here/$ID.xml" "$mimedir/$ID.xml"

    # An absolute Exec rather than a bare name: the desktop environment launches
    # this without the shell's PATH, and ~/.local/bin is not always in the one it
    # does use.
    sed "s|@EXEC@|$exe|" "$here/$ID.desktop" > "$appsdir/$ID.desktop"
    desktop-file-validate "$appsdir/$ID.desktop"

    refresh

    # Claim the default only for uno's own type. The entry also lists csv and
    # tsv so uno appears in "Open With" for them, and taking those over from
    # whatever a person already uses is not this script's decision to make.
    xdg-mime default "$ID.desktop" "$MIME"

    echo
    echo "installed:"
    echo "  $exe"
    echo "  $appsdir/$ID.desktop"
    echo "  $mimedir/$ID.xml"
    verify
}

uninstall_association() {
    rm -f "$appsdir/$ID.desktop" "$mimedir/$ID.xml"
    refresh
    echo "removed the desktop entry and the MIME definition"
    echo "the binary at $bindir/uno was left alone"
}

# verify asks the desktop what it now believes, rather than reporting what this
# script just wrote. The two are only the same if the caches really did rebuild.
verify() {
    local default
    default="$(xdg-mime query default "$MIME" || true)"

    echo "  opened by:             ${default:-nothing}"
    [ "$default" = "$ID.desktop" ] || die "uno is not the default handler for $MIME"

    if command -v gio >/dev/null 2>&1; then
        verify_content_type
    else
        echo "  content type:          not checked, gio is not installed"
    fi
}

# verify_content_type checks that a container is recognised by its name and by
# its bytes, since the glob and the magic rule are separate claims and either can
# be wrong on its own.
verify_content_type() {
    local dir kind magic
    dir="$(mktemp -d)"

    # A zip local file header is 30 bytes before the name it carries, so this is
    # the shortest thing that is a .uno as far as the magic rule is concerned.
    { printf 'PK\003\004'; head -c 26 /dev/zero; printf 'uno.json'; } > "$dir/probe"
    cp "$dir/probe" "$dir/probe.uno"

    kind="$(content_type "$dir/probe.uno")"
    magic="$(content_type "$dir/probe")"
    rm -rf "$dir"

    echo "  a .uno is detected as: ${kind:-nothing}"
    echo "  and without the name:  ${magic:-nothing}"

    [ "$kind" = "$MIME" ] || die "the MIME database does not recognise .uno"
    [ "$magic" = "$MIME" ] ||
        echo "  note: the magic rule did not match, so only named files are recognised" >&2
}

# content_type asks the shared MIME database what a file is.
#
# gio is what GTK file managers use and it reads that database directly.
# "xdg-mime query filetype" is not a substitute: on a desktop it does not have a
# rule for, it shells out to file(1), which knows nothing about the types
# installed under ~/.local/share/mime and answers application/octet-stream for a
# perfectly well registered file.
content_type() {
    gio info -a standard::content-type "$1" 2>/dev/null |
        sed -n 's/^ *standard::content-type: //p'
}

need xdg-mime
need update-mime-database
need update-desktop-database
need desktop-file-validate

case "${1:-install}" in
    install)   install_association "${2:-}" ;;
    uninstall) uninstall_association ;;
    verify)    verify ;;
    *)         die "usage: associate.sh [install [binary] | uninstall | verify]" ;;
esac
