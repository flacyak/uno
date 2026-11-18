#!/usr/bin/env bash
#
# Runs one tier of uno's tests, sized to what a change can break, and prints
# one line with every step's time and result.
#
#   scripts/gate.sh 0 [base]   every edit: check and the tests related to the
#                              changed files, in the packages that changed
#   scripts/gate.sh 1 [base]   once per PR: check both packages, the related
#                              tests, core's lab project when the engine,
#                              ingest or the tallies changed, a build, and the
#                              smoke groups the diff touches
#   scripts/gate.sh 2          the stack's top, and before handing back: check,
#                              the whole suite, a build and the whole smoke
#
# base is the branch below the change, origin/main by default. The change is
# everything since the merge base with it, committed or not. Every step runs
# through uno-bounded when it is on the PATH, so it queues with every other
# agent's run. Run a gate as a command of its own, never chained after another:
# what a tool then shows running is the gate, and its queue wait is its own.

set -uo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly PACKAGES=(core apps/desktop)
# The paths core's lab project measures. A change under them runs it.
readonly MEASURED='^core/(src/(engine|ingest|tally)/|tests/(lab|efficiency|performance)/)'

tier="${1:-}"
base="${2:-origin/main}"
if [[ ! "${tier}" =~ ^[012]$ ]]; then
  echo "usage: scripts/gate.sh 0|1|2 [base]" >&2
  exit 2
fi

bounded=()
command -v uno-bounded >/dev/null && bounded=(uno-bounded --)

cd "${ROOT}" || exit 1
merge_base="$(git merge-base "${base}" HEAD)" || exit 1
changed="$( { git diff --name-only "${merge_base}"; git ls-files --others --exclude-standard; } | sort -u)"

#######################################
# Runs one step in a folder, timing it, and keeps its line for the summary.
# Arguments: name, folder, command...
#######################################
summary=()
failed=0
step() {
  local name="$1" dir="$2"
  shift 2
  local start status=0
  start="$(date +%s)"
  (cd "${dir}" && "${bounded[@]}" "$@") || status=$?
  summary+=("${name} $(( $(date +%s) - start ))s $([[ ${status} -eq 0 ]] && echo ok || echo "FAILED(${status})")")
  [[ ${status} -eq 0 ]] || failed=1
}

#######################################
# Succeeds when a changed path matches the pattern in $1.
#######################################
touched() {
  grep -Eq "$1" <<<"${changed}"
}

#######################################
# The projects core's related tests run: the lab's only when it is touched.
#######################################
core_projects() {
  touched "${MEASURED}" && echo "--project core --project lab" || echo "--project core"
}

case "${tier}" in
  0)
    for pkg in "${PACKAGES[@]}"; do
      touched "^${pkg}/" || continue
      step "check:${pkg}" "${pkg}" vp check
      # shellcheck disable=SC2046  # the projects are separate words on purpose
      step "test:${pkg}" "${pkg}" vp test --changed "${merge_base}" --passWithNoTests \
        $([[ "${pkg}" == core ]] && core_projects)
    done
    ;;
  1)
    step check . vp run check
    for pkg in "${PACKAGES[@]}"; do
      # shellcheck disable=SC2046
      step "test:${pkg}" "${pkg}" vp test --changed "${merge_base}" --passWithNoTests \
        $([[ "${pkg}" == core ]] && core_projects)
    done
    step build . vp run build
    step smoke . vp run smoke -- --affected "${merge_base}"
    ;;
  2)
    step check . vp run check
    step test . vp run test
    step build . vp run build
    step smoke . vp run smoke
    ;;
  *) ;;
esac

if ((${#summary[@]} == 0)); then
  echo "gate ${tier}: nothing changed since ${base}, nothing to run"
  exit 0
fi
echo "gate ${tier}: $(IFS=' · '; echo "${summary[*]}")"
exit "${failed}"
