# Independent team workspace acceptance — 2026-11-10

## Delivered

- Creating or selecting a saved team opens the shared full Bot workspace, not the old management dialog. Conversation, active/completed lists, composer, attachments and team settings reuse the existing UI.
- Team conversations persist a separate `team_id`; personal and team current-conversation indexes are distinct. Two teams with the same leader do not share conversation history, drafts or attachments. Leader changes preserve the team's historical conversation and original message executors.
- Foreground team tools bind creation/query/control to that team. Team conversations do not ingest or write a leader's private memory. Saved-team UI creation binds result delivery to the team conversation.
- Teams have dedicated stable default directories. Explicit team folder settings override the default for new work. Existing work retains its original directory. Folder selection uses the existing native folder-picker API, not upload/import.
- Team settings and recoverable team/ended-work management are reachable from the team workspace. User data was not moved or deleted during acceptance.

## Verification

- `pnpm -s typecheck`: passed, zero new script errors.
- `test:bot-team-conversation`, `test:bot-work-team-service`, `test:bot-conversation-ui`, `test:bot-activity-monitor`: passed.
- `test:bot-team-ui`: 33 behaviour checks passed, including folder selection, cancel/late-result handling, settings persistence, management and team page navigation.
- Backend foreground contract, query-scale, active-request, native Phase 2 and Bot memory checks passed.
- Real Omarchy desktop-session Electron via `pnpm dev`, isolated HOME, real DeepSeek model: `TMPDIR=<short writable directory> pnpm -s test:bot-frontdoor:live --team-workspace` passed.
  - UI-created team opens directly as a full page.
  - A real team commission computes 123 + 456 = 579; an independent foreground 17 + 8 returns 25 while it runs.
  - Team result returns to that conversation and the Work closes `succeeded` without manual acceptance.
  - Switching to the leader's personal page preserves its prior messages; a second team starts independently; returning to team A restores its result.
  - Custom folder is saved through the real settings UI and visible on reopening; the prior Work directory remains unchanged.
- Actual screenshots inspected: team result and team settings. Native OS pointer/keyboard automation and native folder-dialog selection were not part of the CDP acceptance; those are not claimed by this result.

## Findings and limits

The first real run found a genuine default-directory bug: the prior Bot path resolver returned an uncreated path, so team dispatch failed with `invalid_workspace`. This is fixed by preparing the team's own default workspace and verified by the subsequent successful run.

Member-result and owner-completion feedback can still produce two result events for one Work. This was passed to the result-delivery follow-up; this acceptance does not claim that all notification deduplication is finished.

No crash injection, full default suite, packaging, version change, production-profile reset or Vivion update was performed. Crash testing remains deferred per the user's instruction.
