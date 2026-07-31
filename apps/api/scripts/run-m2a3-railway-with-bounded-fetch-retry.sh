#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf '%s\n' \
    'Usage: BOB_RAILWAY_RETRY_GUARD_PATH=<path> run-m2a3-railway-with-bounded-fetch-retry.sh railway run ... -- <child> ...' \
    >&2
  exit 64
}

[[ $# -ge 4 ]] || usage
[[ "$1" == 'railway' && "$2" == 'run' ]] || usage

railway_arguments=()
child_arguments=()
delimiter_found=false
while (($# > 0)); do
  if [[ "$1" == '--' ]]; then
    delimiter_found=true
    shift
    child_arguments=("$@")
    break
  fi
  railway_arguments+=("$1")
  shift
done
[[ "$delimiter_found" == true && ${#child_arguments[@]} -gt 0 ]] || usage

: "${BOB_RAILWAY_RETRY_GUARD_PATH:?BOB_RAILWAY_RETRY_GUARD_PATH is required}"
[[ ${#BOB_RAILWAY_RETRY_GUARD_PATH} -le 4096 ]] || {
  printf '%s\n' 'BOB_RAILWAY_RETRY_GUARD_PATH is too long' >&2
  exit 64
}
[[ "$BOB_RAILWAY_RETRY_GUARD_PATH" != *[$'\001'-$'\037'$'\177']* ]] || {
  printf '%s\n' 'BOB_RAILWAY_RETRY_GUARD_PATH contains a control character' >&2
  exit 64
}
command -v railway >/dev/null 2>&1 || {
  printf '%s\n' 'railway is required' >&2
  exit 69
}
node_launcher="$(command -v node || true)"
[[ "$node_launcher" == /* && -x "$node_launcher" ]] || {
  printf '%s\n' 'an absolute executable node is required' >&2
  exit 69
}

temporary_directory="$(
  mktemp -d "${TMPDIR:-/tmp}/bob-m2a3-railway-fetch-retry.XXXXXX"
)"
chmod 700 "$temporary_directory"
cleanup() {
  rm -rf -- "$temporary_directory"
}
trap cleanup EXIT
active_railway_runner_pid=''
forward_signal_and_exit() {
  local -r signal_name="$1"
  local -r signal_status="$2"
  local runner_status=0

  trap - HUP INT TERM
  if [[ -n "$active_railway_runner_pid" ]]; then
    kill -s "$signal_name" "$active_railway_runner_pid" 2>/dev/null || true
    set +e
    wait "$active_railway_runner_pid" 2>/dev/null
    runner_status=$?
    set -e
  fi
  if ((runner_status == 70)); then
    exit 70
  fi
  exit "$signal_status"
}
trap 'forward_signal_and_exit HUP 129' HUP
trap 'forward_signal_and_exit INT 130' INT
trap 'forward_signal_and_exit TERM 143' TERM

readonly railway_launcher_source='
const { spawn } = require("node:child_process");
const { constants: osConstants } = require("node:os");

const GRACE_MILLISECONDS = 2_000;
const KILL_MILLISECONDS = 2_000;
const POLL_MILLISECONDS = 25;
const signalStatuses = new Map([
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
]);
const [command, ...args] = process.argv.slice(1);
let child;
let terminationPromise;

const delay = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

function groupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

async function waitForGroupExit(processGroupId, budgetMilliseconds) {
  const deadline = Date.now() + budgetMilliseconds;
  while (Date.now() < deadline) {
    if (!groupExists(processGroupId)) {
      return true;
    }
    await delay(POLL_MILLISECONDS);
  }
  return !groupExists(processGroupId);
}

function statusForSignal(signal) {
  const signalNumber = osConstants.signals[signal];
  return Number.isInteger(signalNumber) && signalNumber > 0 && signalNumber < 128
    ? 128 + signalNumber
    : 70;
}

function terminateGroup(exitStatus, initialSignal) {
  if (terminationPromise !== undefined) {
    return terminationPromise;
  }
  terminationPromise = (async () => {
    const processGroupId = child?.pid;
    if (processGroupId === undefined) {
      process.exit(exitStatus);
    }
    if (groupExists(processGroupId)) {
      try {
        process.kill(-processGroupId, initialSignal);
      } catch {}
    }
    if (!(await waitForGroupExit(processGroupId, GRACE_MILLISECONDS))) {
      try {
        process.kill(-processGroupId, "SIGKILL");
      } catch {}
      if (!(await waitForGroupExit(processGroupId, KILL_MILLISECONDS))) {
        process.stderr.write("railway process group did not quiesce\n");
        process.exit(70);
      }
    }
    process.exit(exitStatus);
  })();
  return terminationPromise;
}

for (const signal of signalStatuses.keys()) {
  process.on(signal, () => {
    void terminateGroup(signalStatuses.get(signal), signal);
  });
}

try {
  child = spawn(command, args, {
    detached: true,
    env: process.env,
    stdio: "inherit",
  });
} catch {
  process.stderr.write("railway runner failed before spawn\n");
  process.exit(69);
}

child.once("error", () => {
  process.stderr.write("railway runner failed before exec\n");
  process.exitCode = 69;
});
child.once("exit", (code, signal) => {
  if (terminationPromise !== undefined) {
    return;
  }
  const exitStatus = signal === null ? code ?? 1 : statusForSignal(signal);
  void terminateGroup(exitStatus, "SIGTERM");
});
'

readonly child_launcher_source='
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { constants: osConstants } = require("node:os");

const [markerPath, command, ...args] = process.argv.slice(1);
const descriptor = fs.openSync(markerPath, "wx", 0o600);
fs.closeSync(descriptor);
let child;

function statusForSignal(signal) {
  const signalNumber = osConstants.signals[signal];
  return Number.isInteger(signalNumber) && signalNumber > 0 && signalNumber < 128
    ? 128 + signalNumber
    : 70;
}

try {
  child = spawn(command, args, {
    env: process.env,
    stdio: "inherit",
  });
} catch {
  process.stderr.write("operator launcher failed before spawn\n");
  process.exit(69);
}

child.once("error", () => {
  process.stderr.write("operator launcher failed before exec\n");
  process.exitCode = 69;
});
child.once("exit", (code, signal) => {
  process.exitCode = signal === null ? code ?? 1 : statusForSignal(signal);
});
'

guard_has_evidence() {
  local first_entry

  if [[ ! -e "$BOB_RAILWAY_RETRY_GUARD_PATH" && ! -L "$BOB_RAILWAY_RETRY_GUARD_PATH" ]]; then
    return 1
  fi
  if [[ ! -d "$BOB_RAILWAY_RETRY_GUARD_PATH" || -L "$BOB_RAILWAY_RETRY_GUARD_PATH" ]]; then
    return 0
  fi
  if ! first_entry="$(
    find "$BOB_RAILWAY_RETRY_GUARD_PATH" -mindepth 1 -print -quit 2>/dev/null
  )"; then
    return 0
  fi
  [[ -n "$first_entry" ]]
}

classify_pre_execution_fetch_failure() {
  local -r stderr_path="$1"
  local -r normalized_path="$2"
  local -r maximum_stderr_bytes=1024
  local stderr_bytes

  # Closed allowlist observed with the pinned Railway CLI 5.26.0:
  # - run 30626014174: "Problem processing request";
  # - run 30626237262 attempt 2: the five-line decode envelope below.
  stderr_bytes="$(wc -c <"$stderr_path" | tr -d '[:space:]')"
  [[ "$stderr_bytes" =~ ^[0-9]+$ && "$stderr_bytes" -le "$maximum_stderr_bytes" ]] \
    || return 1

  sed 's/\r$//' "$stderr_path" >"$normalized_path"

  if cmp -s "$normalized_path" <(printf '%s\n' 'Problem processing request'); then
    printf '%s\n' 'problem_processing_request'
    return 0
  fi

  if cmp -s "$normalized_path" <(
    printf '%s\n' \
      'Failed to fetch: error decoding response body' \
      '' \
      'Caused by:' \
      '    0: error decoding response body' \
      '    1: expected ident at line 1 column 2'
  ); then
    printf '%s\n' 'decode_response_body_expected_ident'
    return 0
  fi

  return 1
}

emit_failure() {
  local -r stdout_path="$1"
  local -r stderr_path="$2"
  local -r status="$3"

  cat -- "$stdout_path"
  cat -- "$stderr_path" >&2
  exit "$status"
}

emit_bounded_transport_failure() {
  local -r stderr_path="$1"
  local -r provider_failure="$2"
  local -r status="$3"
  local -r evidence_path="$BOB_RAILWAY_RETRY_GUARD_PATH/railway-control-plane-fetch-failure.json"

  cat -- "$stderr_path" >&2
  mkdir -p -- "$BOB_RAILWAY_RETRY_GUARD_PATH"
  [[ -d "$BOB_RAILWAY_RETRY_GUARD_PATH" && ! -L "$BOB_RAILWAY_RETRY_GUARD_PATH" ]] || {
    printf '%s\n' 'railway_control_plane_fetch_unavailable evidence_path=unsafe' >&2
    exit "$status"
  }
  (
    umask 077
    set -o noclobber
    case "$provider_failure" in
      problem_processing_request | decode_response_body_expected_ident) ;;
      *) exit 64 ;;
    esac
    printf \
      '{"schemaVersion":1,"status":"failed","failureKind":"railway_control_plane_fetch_unavailable","providerFailure":"%s","attempts":3,"childStarted":false}\n' \
      "$provider_failure" \
      >"$evidence_path"
  )
  printf \
    'railway_control_plane_fetch_unavailable provider_failure=%s attempts=3 exhausted=true child_started=false\n' \
    "$provider_failure" \
    >&2
  exit "$status"
}

readonly maximum_attempts=3
readonly -a retry_delays_seconds=(5 20)

for ((attempt = 1; attempt <= maximum_attempts; attempt += 1)); do
  stdout_path="$temporary_directory/stdout-$attempt"
  stderr_path="$temporary_directory/stderr-$attempt"
  normalized_stderr_path="$temporary_directory/stderr-normalized-$attempt"
  child_started_marker="$temporary_directory/child-started-$attempt"

  set +e
  "$node_launcher" -e "$railway_launcher_source" -- \
    "${railway_arguments[@]}" -- \
    "$node_launcher" -e "$child_launcher_source" -- \
    "$child_started_marker" "${child_arguments[@]}" \
    >"$stdout_path" 2>"$stderr_path" &
  active_railway_runner_pid=$!
  wait "$active_railway_runner_pid"
  status=$?
  active_railway_runner_pid=''
  set -e

  if ((status == 0)); then
    cat -- "$stderr_path" >&2
    cat -- "$stdout_path"
    exit 0
  fi

  provider_failure=''
  if ((status == 1)) && [[ ! -s "$stdout_path" && ! -e "$child_started_marker" ]]; then
    provider_failure="$(
      classify_pre_execution_fetch_failure \
        "$stderr_path" \
        "$normalized_stderr_path" \
        || true
    )"
  fi

  if ((status != 1)) \
    || [[ -s "$stdout_path" ]] \
    || [[ -e "$child_started_marker" ]] \
    || guard_has_evidence \
    || [[ -z "$provider_failure" ]]; then
    emit_failure "$stdout_path" "$stderr_path" "$status"
  fi

  if ((attempt == maximum_attempts)); then
    emit_bounded_transport_failure "$stderr_path" "$provider_failure" "$status"
  fi

  delay="${retry_delays_seconds[$((attempt - 1))]}"
  printf \
    'railway_control_plane_fetch_unavailable provider_failure=%s attempt=%d next_attempt=%d max_attempts=%d retry_in_seconds=%d child_started=false\n' \
    "$provider_failure" "$attempt" "$((attempt + 1))" "$maximum_attempts" "$delay" \
    >&2
  sleep "$delay"
done

printf '%s\n' 'railway fetch retry loop exhausted unexpectedly' >&2
exit 70
