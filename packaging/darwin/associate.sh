#!/usr/bin/env bash
#
# Registers .uno with Launch Services, by merging the type declaration into a
# packaged uno.app.
#
# The declaration lives in document-types.plist rather than in a complete
# Info.plist because `fyne package -os darwin` creates that file and renders its
# own template over it every time it runs, so a copy of ours would last exactly
# until the next package. This merges into the bundle afterwards.
#
#   ./associate.sh install [uno.app]     default: ./uno.app
#   ./associate.sh verify  [uno.app]
#   ./associate.sh uninstall [uno.app]
#
# macOS only: PlistBuddy, plutil, lsregister and mdls are all part of the system.
set -euo pipefail

readonly UTI=io.uno.workspace
readonly MIME=application/vnd.uno.workspace+zip
readonly KEYS=(UTExportedTypeDeclarations CFBundleDocumentTypes)

readonly here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly fragment="$here/document-types.plist"
readonly plistbuddy=/usr/libexec/PlistBuddy
readonly lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

die() { echo "associate.sh: $*" >&2; exit 1; }

# bundle resolves the app to patch, and insists on a real one: merging into a
# path that does not exist yet would create a plist describing no application.
bundle() {
    local app="${1:-uno.app}"
    [ -d "$app" ] || die "$app does not exist. Build it first, e.g.
    go build -o uno . && fyne package -os darwin -icon <icon.png>"
    [ -f "$app/Contents/Info.plist" ] ||
        die "$app has no Contents/Info.plist, so it is not an application bundle"
    (cd "$app" && pwd)
}

install_association() {
    local app info
    app="$(bundle "${1:-}")"
    info="$app/Contents/Info.plist"

    [ -x "$plistbuddy" ] || die "$plistbuddy is missing"

    # Delete before merging so a second install replaces the declaration rather
    # than appending a second copy of it to the same arrays.
    for key in "${KEYS[@]}"; do
        "$plistbuddy" -c "Delete :$key" "$info" >/dev/null 2>&1 || true
    done

    "$plistbuddy" -c "Merge $fragment" "$info"
    plutil -lint "$info"

    # Launch Services caches what it knows about a bundle, and it does not watch
    # for a changed Info.plist. This is the nudge; a database rebuild or a login
    # is what settles it if the nudge is not enough.
    touch "$app"
    [ -x "$lsregister" ] && "$lsregister" -f "$app" || true

    echo
    echo "merged into $info"
    verify_association "$app"
}

uninstall_association() {
    local app info
    app="$(bundle "${1:-}")"
    info="$app/Contents/Info.plist"

    for key in "${KEYS[@]}"; do
        "$plistbuddy" -c "Delete :$key" "$info" >/dev/null 2>&1 || true
    done
    plutil -lint "$info"

    touch "$app"
    [ -x "$lsregister" ] && "$lsregister" -f "$app" || true
    echo "removed the .uno declaration from $info"
}

# verify_association makes two separate checks, because they can disagree and
# the difference is the whole story on this platform.
#
# The plist is what uno controls, and it is either right or it is not. Launch
# Services is what the system believes, and it is allowed to lag: a bundle whose
# declaration is perfect still reads as an ordinary zip until the database
# catches up. A wrong plist is a bug; a stale database is a wait.
verify_association() {
    local app info
    app="$(bundle "${1:-}")"
    info="$app/Contents/Info.plist"

    echo "declared in the bundle:"
    check_plist "$info"

    echo
    echo "what Launch Services currently believes:"
    check_launch_services "$app"
}

check_plist() {
    local info="$1" uti ext mime rank

    uti="$(plutil -extract UTExportedTypeDeclarations.0.UTTypeIdentifier raw -o - "$info" 2>/dev/null || true)"
    ext="$(plutil -extract UTExportedTypeDeclarations.0.UTTypeTagSpecification.public\\.filename-extension.0 raw -o - "$info" 2>/dev/null || true)"
    mime="$(plutil -extract UTExportedTypeDeclarations.0.UTTypeTagSpecification.public\\.mime-type.0 raw -o - "$info" 2>/dev/null || true)"
    rank="$(plutil -extract CFBundleDocumentTypes.0.LSHandlerRank raw -o - "$info" 2>/dev/null || true)"

    echo "  type:      ${uti:-nothing}"
    echo "  extension: ${ext:-nothing}"
    echo "  media type:${mime:+ $mime}${mime:-  nothing}"
    echo "  rank:      ${rank:-nothing}"

    [ "$uti" = "$UTI" ]   || die "the bundle does not declare $UTI"
    [ "$ext" = "uno" ]    || die "the bundle does not claim the .uno extension"
    [ "$mime" = "$MIME" ] || die "the bundle does not claim $MIME"
    [ "$rank" = "Owner" ] || die "the bundle does not claim to own the type"
}

# check_launch_services asks what a real .uno is taken for. mdls reports the
# type the system settled on, so it answers the question the plist cannot: not
# "what did we declare" but "what does the Finder think this file is".
check_launch_services() {
    local app="$1" dir probe kind

    # Beside the bundle rather than in /tmp, which is not always indexed.
    dir="$(dirname "$app")"
    probe="$dir/.uno-probe.uno"

    # A zip local file header is 30 bytes before the name it carries, so this is
    # the shortest thing that is a .uno by both name and content.
    { printf 'PK\003\004'; head -c 26 /dev/zero; printf 'uno.json'; } > "$probe"
    mdimport "$probe" >/dev/null 2>&1 || true

    kind="$(mdls -name kMDItemContentType -raw "$probe" 2>/dev/null || true)"
    rm -f "$probe"

    echo "  a .uno is seen as: ${kind:-nothing}"

    if [ "$kind" = "$UTI" ]; then
        echo "  registered."
        return 0
    fi

    # Not an error. The declaration is checked above and is what uno is
    # responsible for; this half is the system's own timing.
    echo
    echo "  not registered yet. That is expected straight after a merge: Launch"
    echo "  Services rescans on its own schedule. To force it:"
    echo "    $lsregister -kill -r -domain local -domain system -domain user"
    echo "  or log out and back in, then run: $0 verify $app"
}

[ "$(uname)" = Darwin ] || die "this only does anything on macOS"

case "${1:-install}" in
    install)   install_association "${2:-}" ;;
    uninstall) uninstall_association "${2:-}" ;;
    verify)    verify_association "${2:-}" ;;
    *)         die "usage: associate.sh [install|verify|uninstall] [uno.app]" ;;
esac
