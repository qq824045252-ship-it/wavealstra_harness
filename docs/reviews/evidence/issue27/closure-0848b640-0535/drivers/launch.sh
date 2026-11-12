#!/usr/bin/env bash
set -euo pipefail

D=/home/vivion/iq27-tmp/closure-v6
true
export TMPDIR=/home/vivion/iq27-tmp
export ISSUE27_SOURCE=$(cat "$D/source-path.txt")
export ISSUE27_RUNNER="$D/runner.cjs" ISSUE27_SCENARIO="$D/scenario.cjs"
export ISSUE27_PROBE_BOOTSTRAP=/home/vivion/iq27-tmp/closure-v6/bootstrap.cjs
export BOT_SCHEDULING_SNAPSHOT=0848b640ffc74bf501343b358a7d1974974a7401
export BOT_FRONTDOOR_BASE_URL=http://127.0.0.1:3425/v1 BOT_FRONTDOOR_MODEL=opendesign/deepseek-v4.1-flash
export BOT_SCHEDULING_LOAD_NOTE='Single instrumented model batch; probe and zero-model UI preparation completed first. Unrelated host or gateway load not controlled; no model baseline comparison claimed.'
export BOT_SCHEDULING_HOME=$(mktemp -d /home/vivion/iq27-tmp/i27-XXXXXX)
export npm_execpath=$(command -v pnpm)
printf '%s\n' "$BOT_SCHEDULING_HOME" > "$D/live-home.txt"
date -u +%FT%T.%3NZ > "$D/live-start-utc.txt"
set +e
node "$D/runner.cjs" > "$D/live-run.log" 2>&1
RESULT=$?
set -e
printf '%s\n' "$RESULT" > "$D/live-exit.txt"
date -u +%FT%T.%3NZ > "$D/live-end-utc.txt"
true > "$D/post-run-frozen-check.json"
cat "$D/live-run.log"
exit "$RESULT"
