#!/usr/bin/env bash
#
# Runs the smoke and the suite again and again on the checkout it is in, and
# writes every check and test that failed even once, with how often.
#
#   scripts/flake-watch.sh [smoke runs (10)] [suite runs (3)]
#
# A flaky check is a fix to make, and this finds it on a quiet machine before
# an agent meets it mid-stack. Every run goes through uno-bounded when it is
# on the PATH. The report is out/flake/report.md, with each run's log beside
# it. Run it by hand when a check is suspected, or before a stack's last gate.

set -uo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly OUT="${ROOT}/out/flake"
readonly CHECKS="${ROOT}/apps/desktop/out/smoke/checks.json"
smoke_runs="${1:-10}"
suite_runs="${2:-3}"

bounded=()
command -v uno-bounded >/dev/null && bounded=(uno-bounded --)

cd "${ROOT}" || exit 1
rm -rf "${OUT}"
mkdir -p "${OUT}"
failures="${OUT}/failures.txt"
: >"${failures}"

for ((n = 1; n <= smoke_runs; n++)); do
  rm -rf apps/desktop/out/smoke
  "${bounded[@]}" vp run smoke >"${OUT}/smoke-${n}.log" 2>&1 || echo "smoke run ${n} failed" >>"${failures}"
  # Every check that failed, by name, from what the run wrote.
  [[ -f "${CHECKS}" ]] && node -e '
    const checks = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const c of checks) if (!c.ok) console.log(`smoke check: ${c.name}`);
  ' "${CHECKS}" >>"${failures}"
done

for ((n = 1; n <= suite_runs; n++)); do
  "${bounded[@]}" vp run test >"${OUT}/suite-${n}.log" 2>&1 || echo "suite run ${n} failed" >>"${failures}"
  # vitest names each failed test on a line that starts with ×.
  sed -n 's/^ *× \(.*\) [0-9]*ms$/test: \1/p' "${OUT}/suite-${n}.log" >>"${failures}"
done

{
  echo "# Flake watch, $(date -I), $(git rev-parse --short HEAD)"
  echo
  echo "${smoke_runs} smoke runs and ${suite_runs} suite runs."
  echo
  if [[ ! -s "${failures}" ]]; then
    echo "Nothing failed."
  else
    echo "| failed | times |"
    echo "| --- | --- |"
    sort "${failures}" | uniq -c | sort -rn | sed 's/^ *\([0-9]*\) \(.*\)$/| \2 | \1 |/'
  fi
} >"${OUT}/report.md"
cat "${OUT}/report.md"
[[ ! -s "${failures}" ]]
