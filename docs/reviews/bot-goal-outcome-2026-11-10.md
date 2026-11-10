# Goal completion and empty New Conversation regression

## Observed issue

On Vivion `53574d2`, a team was asked to inspect a project and list bugs, not repair them. Its member and owner executions completed and delivered reports, but the Work was closed as `ended_unsuccessfully`. The owner-summary fast path never invoked goal review (`attempts=0`): a still-pending manual criterion and one historical unknown tool receipt automatically forced partial completion. Finding defects was not itself a failure of this user's request.

The team's conversation was empty while its report existed on a Work. `New Conversation` was disabled solely because `messages.length === 0`, including when browsing another tab. The input remained usable, but navigation looked broken.

## Changes

- Team owner summaries use the same independent, read-only goal review as individual results. Review instructions distinguish the requested goal from optional tests, discovered defects, manual attestation state and tool diagnostics.
- Persist whether a delivery actually received goal review. Reviewed goal completion can finish despite unmodified manual attestation or unrelated historical uncertainty. Native missing-output, write-conflict and rejected-result facts still cannot be promoted to success.
- Do not alter old Work, manual evidence, action receipts, or replay uncertain operations. An unknown effect required by the actual requested outcome remains unknown/partial. Keep real diagnostic observations available to the reviewer rather than labeling all of them actual missing user requirements.
- Empty `New Conversation` returns to the conversation view and focuses its composer; nonempty chats retain archive-and-start behaviour.

## Verification

- Typecheck: passed, scripts 0 new errors.
- `test:bot-work-automatic-completion`: passed. Includes goal review with pending manual criteria and historical unknown receipt, no forged attestation/receipt, no replay, actual partial results, missing native output, delivery failure, late evidence and watch behaviour.
- `test:bot-workspace`: passed, including empty New Conversation is enabled.
- `test:bot-team-ui`: 33 checks passed.
- Actual Electron `pnpm dev`, isolated HOME, real DeepSeek transport: team audits `function add(a,b){return a-b;}` without editing code. Reports actual -333 versus expected 579, receives independent goal review and closes `succeeded`. Concurrent question answers 25. Empty team New Conversation focuses input; personal and second-team histories stay separate. Settings roundtrip keeps previous Work workspace.
- A repeated real-model run hit the existing 60-second result-review timeout once. Its automatic second review succeeded, with no business execution replay. This latency is recorded rather than hidden as a clean first-attempt pass.
- Integrated `fd45f17`, including `d82411e` conversation delivery and user diagnostics changes; typecheck plus automatic-completion, workspace, feedback, team-conversation and all 16 review-execution checks passed.
- No user production profile changed, no crash injection, no build/package/version change. This does not claim the full crash-including aggregate suite or Windows live UI passed.

Reproduce real UI/model check on Omarchy:

```sh
mkdir -p out/tmp
TMPDIR="$PWD/out/tmp" npm_execpath="$(command -v pnpm)" node scripts/bot-goal-outcome-live-test.cjs
```

The script uses an isolated profile and the configured local model endpoint (default `http://127.0.0.1:3425/v1`). Reports/screenshots are under `out/diagnostics/bot-goal-outcome/live`. It closes only its owned isolated instance normally.
