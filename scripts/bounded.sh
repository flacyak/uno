#!/usr/bin/env bash
#
# Runs a build, check, test, smoke or preview of uno so that it cannot take
# the machine down, and leaves nothing running once it ends.
#
# Agents run many of these at once, from many worktrees. Unbounded, each test
# run loads every core for minutes, writes thousands of temporary directories
# to /tmp (memory, on most Linux desktops), and whatever a killed run started,
# an Electron window or a pool of vitest workers, keeps running after it. On
# one development machine that load set off L2 cache machine-check errors and
# reset it, three times in a day. A run through this script:
#
# - waits for one of a few slots that every worktree on the machine shares,
#   and a run that drives the display (smoke, preview) waits for the display;
# - is pinned to a share of the CPUs, both threads of a core before the next
#   core, inside a systemd scope under one slice whose CPU, memory and task
#   limits all runs share;
# - gets a temporary directory of its own on disk, as TMPDIR;
# - is stopped at a deadline, even if nothing is left to stop it; and
# - once it ends, however it ends, has every process it started stopped,
#   those that moved themselves to a scope of their own included, and its
#   temporary directory removed.
#
# Electron moves its main process to a scope of its own
# (app-uno-desktop-<pid>.scope), out of the slice. It keeps the run's CPUs,
# which a process takes with it, and every process a run starts carries
# UNO_BOUNDED_RUN, which is how the run finds it to stop it.
#
# Usage:
#   scripts/bounded.sh [--display] [--timeout <seconds|Nm|Nh>] -- <command>...
#
# Examples:
#   scripts/bounded.sh -- vp run test
#   scripts/bounded.sh -- vp run smoke
#   (cd core && ../scripts/bounded.sh -- vp test tests/engine/save.test.ts)
#
# A command that names smoke, preview or electron drives the display without
# --display. Inside a bounded run the script runs its command as it is.
#
# The limits come from the environment, with defaults sized for a desktop:
#   UNO_BOUNDED_SLOTS    runs at once on the machine (2)
#   UNO_BOUNDED_CPUS     logical CPUs all runs share (half the machine's)
#   UNO_BOUNDED_MEMORY   memory all runs share, as systemd takes it (half)
#   UNO_BOUNDED_TASKS    processes and threads all runs share (4096)
#   UNO_BOUNDED_TIMEOUT  seconds one run may take (1800)

set -euo pipefail

readonly STATE="${XDG_CACHE_HOME:-${HOME}/.cache}/uno-bounded"
readonly SLICE="uno-bounded.slice"
readonly MARKER="UNO_BOUNDED_RUN"
readonly SLOTS="${UNO_BOUNDED_SLOTS:-2}"
readonly TASKS="${UNO_BOUNDED_TASKS:-4096}"
readonly DEFAULT_TIMEOUT_SECONDS="${UNO_BOUNDED_TIMEOUT:-1800}"
# How often a waiting run looks for a free slot, and the guard for its run.
readonly POLL_SECONDS=2
# How long a stopped process has between SIGTERM and SIGKILL.
readonly STOP_SECONDS=10
# The scope's own deadline is this much past the run's, in case the guard
# that enforces the run's is gone too.
readonly BACKSTOP_SECONDS=60
readonly NICENESS=10
# coreutils timeout's exit status for a command stopped at its deadline.
readonly TIMED_OUT_STATUS=124
# Commands that start Electron: the smoke, the preview, and Electron itself.
# The happy-dom tests under tests/smoke/ do not match.
readonly DISPLAY_COMMANDS=' (smoke|preview) |smoke\.js|preview\.js|electron'

#######################################
# Prints a line to stderr, prefixed so it reads apart from the command's.
#######################################
say() {
  echo "bounded: $*" >&2
}

#######################################
# Prints the number of online logical CPUs.
#######################################
cpu_count() {
  getconf _NPROCESSORS_ONLN
}

#######################################
# Prints a CPU list ("0,8,1,9") of the first $1 logical CPUs, taking every
# thread of a core before the next core, so the runs heat as few cores as
# they can.
#######################################
cpu_list() {
  local want="$1" cpu sibling
  local -a picked=()
  local -A taken=()
  for cpu in $(printf '%s\n' /sys/devices/system/cpu/cpu[0-9]* | sort -V); do
    local siblings="${cpu}/topology/thread_siblings_list"
    [[ -r "${siblings}" ]] || continue
    for sibling in $(expand_list "$(<"${siblings}")"); do
      [[ -n "${taken[${sibling}]:-}" ]] && continue
      taken[${sibling}]=1
      picked+=("${sibling}")
      if ((${#picked[@]} >= want)); then
        (IFS=,; echo "${picked[*]}")
        return
      fi
    done
  done
  (IFS=,; echo "${picked[*]}")
}

#######################################
# Expands a kernel CPU list ("0-2,8") to one number per word.
#######################################
expand_list() {
  local part
  for part in ${1//,/ }; do
    if [[ "${part}" == *-* ]]; then
      seq "${part%-*}" "${part#*-}"
    else
      echo "${part}"
    fi
  done
}

#######################################
# Prints half the machine's memory, in kibibytes as systemd reads them.
#######################################
half_memory() {
  local kib
  kib="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)"
  echo "$((kib / 2))K"
}

#######################################
# Prints a duration given as seconds, Nm or Nh, in seconds.
#######################################
seconds_of() {
  case "$1" in
    *h) echo "$((${1%h} * 3600))" ;;
    *m) echo "$((${1%m} * 60))" ;;
    *) echo "$(($1))" ;;
  esac
}

#######################################
# Succeeds when a systemd user manager can take scopes for this user.
#######################################
have_systemd() {
  command -v systemd-run >/dev/null || return 1
  local state
  state="$(systemctl --user is-system-running 2>/dev/null || true)"
  [[ "${state}" == running || "${state}" == degraded ]]
}

#######################################
# Prints the pids of every process that carries run $1's marker, wherever
# its cgroup is now.
#######################################
marked_pids() {
  local file
  grep -lzx "${MARKER}=$1" /proc/[0-9]*/environ 2>/dev/null \
    | while read -r file; do
      file="${file#/proc/}"
      echo "${file%/environ}"
    done
}

#######################################
# Stops everything run $1 started and removes its directory. Safe to call
# more than once, and from the guard after the run's own script is gone.
#######################################
# shellcheck disable=SC2329  # the EXIT trap calls it
cleanup_run() {
  local id="$1" pid names=""
  systemctl --user stop "uno-bounded-${id}.scope" >/dev/null 2>&1 || true
  local -a left
  mapfile -t left < <(marked_pids "${id}")
  if ((${#left[@]} > 0)); then
    for pid in "${left[@]}"; do
      names+=" $(cat "/proc/${pid}/comm" 2>/dev/null || echo "${pid}")"
    done
    kill -TERM "${left[@]}" 2>/dev/null || true
    local waited=0
    while ((waited < STOP_SECONDS)) && [[ -n "$(marked_pids "${id}")" ]]; do
      sleep 1
      waited=$((waited + 1))
    done
    mapfile -t left < <(marked_pids "${id}")
    ((${#left[@]} == 0)) || kill -KILL "${left[@]}" 2>/dev/null || true
    echo "$(date -Is) ${id}:${names}" >>"${STATE}/escaped.log"
    say "stopped what outlived the command:${names}"
  fi
  rm -rf "${STATE}/runs/${id}"
}

#######################################
# Waits for one of the machine's slots, and holds it on fd 8 for as long as
# this script lives.
#######################################
take_slot() {
  local n told=0
  while true; do
    for ((n = 1; n <= SLOTS; n++)); do
      exec 8>"${STATE}/slots/${n}.lock"
      flock -n 8 && return
      exec 8>&-
    done
    if ((!told)); then
      say "waiting for a slot"
      told=1
    fi
    sleep "${POLL_SECONDS}"
  done
}

#######################################
# Waits for the display and holds it on fd 9 for as long as this script
# lives.
#######################################
take_display() {
  exec 9>"${STATE}/display.lock"
  flock -n 9 && return
  say "waiting for the display"
  flock 9
}

#######################################
# Watches run $1 from outside it: stops it at its deadline $3 (epoch
# seconds), and cleans up once the script $2 that started it is gone, even
# if that script was killed before it could.
#######################################
guard() {
  local id="$1" owner="$2" deadline="$3"
  while kill -0 "${owner}" 2>/dev/null; do
    if (($(date +%s) >= deadline)) && [[ ! -e "${STATE}/runs/${id}/deadline" ]]; then
      touch "${STATE}/runs/${id}/deadline"
      systemctl --user stop "uno-bounded-${id}.scope" >/dev/null 2>&1 || true
      local -a left
      mapfile -t left < <(marked_pids "${id}")
      ((${#left[@]} == 0)) || kill -TERM "${left[@]}" 2>/dev/null || true
    fi
    sleep "${POLL_SECONDS}"
  done
  [[ -d "${STATE}/runs/${id}" ]] && cleanup_run "${id}"
}

#######################################
# Runs a command bounded. See the top of the file.
#######################################
run() {
  local display=0 timeout="${DEFAULT_TIMEOUT_SECONDS}"
  while (($# > 0)); do
    case "$1" in
      --display) display=1 ;;
      --timeout) timeout="$(seconds_of "$2")"; shift ;;
      --) shift; break ;;
      *) break ;;
    esac
    shift
  done
  if (($# == 0)); then
    say "no command; usage is at the top of $0"
    exit 2
  fi
  if [[ -n "${!MARKER:-}" ]]; then
    exec "$@"
  fi
  [[ " $* " =~ ${DISPLAY_COMMANDS} ]] && display=1

  mkdir -p "${STATE}/slots" "${STATE}/runs"
  take_slot
  ((display)) && take_display

  local id cpus
  id="$(date +%s)-$$"
  cpus="$(cpu_list "${UNO_BOUNDED_CPUS:-$(($(cpu_count) / 2))}")"
  local dir="${STATE}/runs/${id}"
  mkdir -p "${dir}/tmp"

  trap 'cleanup_run "${id}"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP
  setsid bash "${BASH_SOURCE[0]}" __guard "${id}" "$$" \
    "$(($(date +%s) + timeout))" \
    </dev/null >/dev/null 2>&1 8>&- 9>&- &

  local -a wrap=(env "${MARKER}=${id}" "TMPDIR=${dir}/tmp" nice -n "${NICENESS}")
  [[ -n "${cpus}" ]] && command -v taskset >/dev/null \
    && wrap+=(taskset -c "${cpus}")
  if have_systemd; then
    local cpu_count_used
    cpu_count_used="$(expand_list "${cpus}" | wc -l)"
    systemctl --user set-property --runtime "${SLICE}" \
      "CPUQuota=$((cpu_count_used * 100))%" \
      "MemoryMax=${UNO_BOUNDED_MEMORY:-$(half_memory)}" MemorySwapMax=0 \
      "TasksMax=${TASKS}"
    systemd-run --user --scope --quiet --slice="${SLICE}" \
      --unit="uno-bounded-${id}.scope" \
      --property="TimeoutStopSec=${STOP_SECONDS}s" \
      --property="RuntimeMaxSec=$((timeout + BACKSTOP_SECONDS))s" \
      -- "${wrap[@]}" "$@" 8>&- 9>&- &
  else
    setsid "${wrap[@]}" "$@" 8>&- 9>&- &
  fi
  local status=0
  wait "$!" || status=$?
  if [[ -e "${dir}/deadline" ]]; then
    say "stopped at its deadline of ${timeout}s: $*"
    exit "${TIMED_OUT_STATUS}"
  fi
  exit "${status}"
}

main() {
  case "${1:-}" in
    __guard) shift; guard "$@" ;;
    *) run "$@" ;;
  esac
}

main "$@"
