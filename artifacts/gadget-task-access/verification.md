# Gadget task access — MyBuddy 0.1.66

Validated on Windows on 2026-11-02.

## Reproduction and change

The original task-scoped list returned only the task's own Gadget, even with
`includeInherited: true`; the regression test expected task, workspace and personal
Gadgets and failed with one item instead of three. The Agent extension exposed only
`gadget_create`. Empty/loading task views did not mount a Gadget section at all.

- Tasks now discover their own Gadgets, their current workspace and ancestor
  workspace Gadgets, and personal Gadgets. Sibling tasks' private Gadgets remain
  inaccessible. Access is checked against the task's live workspace on every Agent
  read, update and open operation.
- Added native `gadget_list`, `gadget_read`, `gadget_update` and `gadget_open` tools.
  Read-only mode permits reading and rejects source changes; approval rejection
  leaves the original files untouched.
- Source editing uses exact source and an expected revision. A stale save is
  rejected. Changed files are staged and replaced individually, retaining the
  running host's working directory on Windows. Failed commits roll back applied
  files. Unmentioned files, Gadget ID/scope and the data directory remain intact.
- Task cards expose source editing. Empty/loading tasks also display available
  Gadgets. Open viewers refresh after saves. Agent open requests target their own
  task and do not open a second overlay or switch away from the active task.
- Blueprint capture and Artifact export semantics are unchanged. No database schema
  change or migration was introduced.

## Verification

- `pnpm -s typecheck`: passed; no new script type errors (existing ratchet debt retained).
- `pnpm -s test:gadget-blueprint`: passed, including scope isolation, ancestor
  discovery, live task rebinding, native tool registration, actual HTTP rendering,
  source edits while running, stale-save rejection, path validation, rollback,
  retained unmodified files/data, and read-only/rejected updates.
- `pnpm -s test:all`: 247 passed, 0 failed, 0 known failures, 0 regressions.
  IPC inventory was deliberately updated for `gadget:readSource` and
  `gadget:updateSource`; the failure baseline was not changed.
- `node scripts/test-all.mjs --audit`: passed. The new desktop test is classified as GUI.
- Remote and desktop production builds: passed.
- `pnpm -s test:gadget-task-desktop`: passed against the actual development build
  and the actual packaged executable. Each run used temporary HOME/userData with
  empty credentials. Native mouse/key input verified task discovery, opening,
  source editing/saving, rendered results, automatic refresh and task-specific
  Agent open-event handling. Tool execution itself is covered by the domain test;
  no external model inference was required for this fixture.
- Packaged `afterPack` and explicit `verify:packaged`: passed. All 588 unpacked
  entries exist; the packaged Pi worker starts with the expected runtime version.
- Packaged main bundle SHA-256 matches the tested production build:
  `7da07b3593cb833a36ce5f7b10ba03976a69740dbcc20535504eaa4b58587101`.

## Accepted deployment

- Executable: `release/gadget-fix-0.1.66/win-unpacked/MyBuddy.exe`.
- Executable SHA-256:
  `f5cfecad9eeaa17eaee986a6908178c24b67731b34281b994d9087377ffc4bbf`.
- Desktop `MyBuddy 0.1.66.lnk` and Start Menu `MyBuddy.lnk` target the accepted
  executable. Target, working directory, icon, arguments and `com.mybuddy.app`
  identity were read back and verified.
- The previous app was no longer running when the accepted app was started. No
  live user process was stopped. The accepted executable was confirmed running.
- Read-only database checks before/after startup confirmed the same schema and
  counts: 108 tasks, 38 spaces, 2 Gadgets.
- Obsolete `release/win-unpacked` was removed with FastCopy only after checking its
  resolved path, absence of process/shortcut references, and the accepted app's
  hash/startup. Cleanup reported zero file/directory errors.

Local diagnostics and screenshots are under
`out/diagnostics/gadget-fix-0.1.66/`; headless gate output is
`out/gadget-gate.log`. Existing unrelated source/diagnostic changes were not staged.
