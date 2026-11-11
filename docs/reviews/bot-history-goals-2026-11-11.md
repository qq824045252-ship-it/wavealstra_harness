# Bounded Bot history and complete Work goals

## Changes

- Main personal/team conversations now expose an explicit older-history control, loading at most 100 messages per click. Repeated clicks coalesce. Exhaustion and failures remain visible without replacing the focused control.
- Latest polling merges by persistent message identity/revision instead of replacing the loaded history. A burst exceeding the latest page catches up in bounded forward pages; loaded unfinished replies outside that page are reconciled by at most 100 scoped IDs per refresh, rotating if necessary. This repairs missed completion events without draining all history.
- The existing scroll-follow hook preserves the visible message anchor on prepend, asynchronous content growth and resize, including navigation while a page is pending. New output does not steal the reader's position. Returning to latest explicitly resumes following.
- Work projections now carry the persisted complete goal description. Existing scoped list search indexes that description. Details preserve whitespace and wrap long text.
- Original delegation is read only for one Work on demand through the existing detail API. It uses host-owned message provenance, identifies assistant-authored plans, and preserves user/assistant roles for context. Normal list/sync responses never eagerly load original messages.

## Verification completed

Work ran in an independent main clone on Omarchy. No production profile/database, running application, installation, package or release was changed. No real model was invoked.

- `pnpm -s typecheck`: passed, including all script checks, zero script errors.
- `test:bot-history-paging`: bounded pages, duplicate request coalescing, concurrent prepend/latest/stream merges, large-burst catch-up, off-page completion reconciliation, conversation replacement, wrong-scope responses, EOF and retry passed.
- `test:bot-history-paging-sqlite`: real persistent SQLite reopened before reading; 100/100/50 pages, exact-full-page EOF, stable ordinals, scoped forward/ID reads and Bot/team/user fences passed.
- Real shown Electron `test:bot-history-paging-desktop`: personal/team × 1440/760/390; pagination, native repeated clicks, concurrent new messages, navigation while pending, focus, anchor preservation, late layout growth, resize, EOF and explicit latest passed. Final runs were sequential. Narrow and wide screenshots were inspected.
- Real shown Electron `test:bot-scroll-desktop`, `test:bot-conversation-concurrent-desktop`, and `test:bot-work-detail-desktop` passed. Work details covered 390/760/1440, full goal text, long unbroken words, on-demand original messages, role labels, late-response rejection and a goal-only search hit beyond the first 60 items without extra detail fetches.
- `test:bot-conversation-ui`, `test:app-store-structure`, `test:app-store-runtime`, `test:bot-work-phase2`, `test:bot-work-phase2-invariants`, `test:bot-work-team-access`, `test:bot-workspace`, and `test:bot-delegation-fidelity` passed. Fidelity includes database reopen and original-input tenant/role isolation.
- `git diff --check` and `node scripts/test-all.mjs --audit` passed. A stale menu-count assertion in the existing workspace test was changed to explicit actual-entry assertions.

This is risk-focused verification, not a full `test:all`, live-model, packaged-artifact or Windows/macOS acceptance claim. Local screenshots/logs remain under `out/tests` and `out/diagnostics/history-goal`.
