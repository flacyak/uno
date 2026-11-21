#!/usr/bin/env bash
#
# Prints the version after the last release. A release is tagged
# v<major>.<minor>.<patch>; the part named counts up from the highest tag, and
# the parts after it go back to 0. Before the first release the count starts
# from 0.0.0.
#
# Usage: scripts/next-version.sh patch|minor|major

set -euo pipefail

bump="${1:-}"
case "${bump}" in
  patch | minor | major) ;;
  *)
    echo "usage: $0 patch|minor|major" >&2
    exit 2
    ;;
esac

# The remote's tags, so a checkout that fetched few of them, as a runner's
# does, still sees every release.
latest="$(git ls-remote --tags --refs origin 'refs/tags/v*' \
  | sed 's#.*refs/tags/v##' \
  | { grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' || true; } \
  | sort -V | tail -n 1)"

IFS=. read -r major minor patch <<<"${latest:-0.0.0}"
case "${bump}" in
  major) major=$((major + 1)); minor=0; patch=0 ;;
  minor) minor=$((minor + 1)); patch=0 ;;
  patch) patch=$((patch + 1)) ;;
esac
echo "${major}.${minor}.${patch}"
