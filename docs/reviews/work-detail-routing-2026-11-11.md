# Unified Work details in the conversation area

## Cause and change

The previous `BotWorkspacePage.openWork` and selection effect explicitly routed only the conversation tab through `BotWorkConversationDetail`. Active, completed, and archived lists still mounted the old inspector dialog. The supplied completed/archive screenshots matched that branch.

- Removed that second inspector route. Personal and named-team conversation links, active/completed/archive cards, and store-selected Work entries now reuse the inline detail.
- Keep the source list mounted and hidden while reading. Return restores query, filter, ordering, page, scroll and focus. The breadcrumb names the actual source view.
- Keep details connected to current projections and retain closed records while reading. List return does not depend on asynchronously loaded conversation identity. If the original card leaves the list, focus falls back to the list.
- Removed the separate temporary/historical-team modal detail branch. An explicit runtime-only historical Work route uses the real Work snapshot/ID and newer store projections. It does not create a team identity, change the active team, or select the Work in the message composer. Existing team-management controls remain available. No nonfunctional reply callback is supplied.
- Explicit navigation invalidates historical routing and stale asynchronous team-detail lookups. Source chat/list/detail remains mounted for return. The shared header receives focus on mount, with a frame fallback if a closing native navigation drawer temporarily blocks focus.

## Verification actually completed

All work used an independent `main` clone on Omarchy. Production source, live profile/database and running application were not changed. No package/release was built or installed.

Before the final historical-route additions:

- `pnpm -s typecheck`: passed, including the expanded fixture scripts, zero script errors.
- `test:bot-workspace`: passed.
- `test:bot-work-phase5-review-ui`: 14 React lifecycle cases passed.
- `test:bot-workspace-navigation-ui`: passed (DOM fixture, not a layout claim).
- `test:bot-work-team-access`, `test:bot-workspace-navigation`, `test:app-store-runtime`: passed using local temporary storage after `/tmp` quota errors.
- Real shown Electron fixture: personal/named-team × active/completed/archive × 1440/1100/760/390, all 24 combinations passed. Tested native card clicks, breadcrumb/close/Escape, resize without remount, bounded lists, query/filter/sort/page, nonzero scroll and focus restoration. Prior conversation cases, saved-file target and ownership fences also passed. Two earlier full runs exited 0.
- Inspected actual 1440px completed and 390px team-archive screenshots. Details occupy the conversation area and return controls remain accessible.

## Limits of the final state

Automatic testing was stopped. No subsequent test edits or reruns were made after that restriction.

- The latest expanded Electron run passed all 24 list combinations but failed the newly added immediate deep-link Escape case before reaching the two additional return edge cases. The focus implementation was subsequently changed, but that final change is **not reverified**.
- Historical/temporary-team routing, its store navigation guard, and final return/focus changes were reviewed as source only. They have **not** had a final typecheck or Electron run.
- Isolated `pnpm dev` acceptance reached and passed actual UI → preload → host → native task → result detail → close, plus list search/filter/pagination and compact Escape. The overall script exited 1 at its old synthetic-fixture cleanup: a delta refresh did not remove synthetic rows, and its final expected active-card count was stale. It is not recorded as a passing full-app suite.
- No full `test:all`, packaged-artifact check, installation or production restart was performed.

Local evidence (not committed): `out/tests/all-work-detail-electron.log`, `out/tests/bot-list-detail-*.png`, `out/diagnostics/bot-work-browser/dev/report.json`. These use isolated fixture data.
