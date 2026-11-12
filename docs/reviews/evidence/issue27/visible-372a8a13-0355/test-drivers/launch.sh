#!/usr/bin/env bash
set -euo pipefail
D=/home/vivion/iq27-tmp/visible-v5
export TMPDIR=/home/vivion/iq27-tmp PNPM_MANAGE_PACKAGE_MANAGER_VERSIONS=false
export ISSUE27_SOURCE=$(cat "$D/source-path.txt") ISSUE27_RUNNER="$D/runner.cjs" ISSUE27_SCENARIO="$D/scenario.cjs"
export BOT_SCHEDULING_SNAPSHOT=$(cat "$D/source-sha.txt")
export BOT_FRONTDOOR_BASE_URL=http://127.0.0.1:3425/v1 BOT_FRONTDOOR_MODEL=opendesign/deepseek-v4.1-flash
export BOT_SCHEDULING_LOAD_NOTE='Six semantic functional tasks after narrowly focused checks. No performance-distribution claim, no heavy tracing.'
export BOT_SCHEDULING_HOME=$(mktemp -d /home/vivion/iq27-tmp/i27-XXXXXX)
export npm_execpath=$(command -v pnpm)
unset ISSUE27_PROBE_BOOTSTRAP
printf '%s\n' "$BOT_SCHEDULING_HOME" > "$D/live-home.txt"
date -u +%FT%T.%3NZ > "$D/live-start-utc.txt"
set +e
node "$D/runner.cjs" > "$D/live-run.log" 2>&1
RESULT=$?
set -e
printf '%s\n' "$RESULT" > "$D/live-exit.txt"
date -u +%FT%T.%3NZ > "$D/live-end-utc.txt"
cat "$D/live-run.log"
exit "$RESULT"
