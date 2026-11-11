# Gmail and Calendar integration · 2026-11-11

## Scope

MyBuddy now uses the existing local Python `gws` CLI directly for Gmail search/read and Google Calendar agenda reads. The adapter intentionally targets that CLI's `gmail search`, `gmail read`, and `cal agenda` grammar, not an unrelated executable with the same name. It never runs marketplace commands, installs software, reads credential files itself, starts authentication, or adds OAuth permissions.

- The former Agent Mail signup placeholder is replaced with a working **邮箱和日历** page, reachable from the account navigation menu.
- Queries are explicit. No account or inbox query runs on page mount, tool registration, or app startup. A connection check probes only Gmail and Calendar with minimal read requests, not every API in `gws status`.
- Bot foreground and Work have four native read tools, without requiring the user to attach a private connector skill: `gmail_search`, `gmail_read`, `calendar_agenda`, and explicit `google_workspace_status`. Existing foreground allowlists and Work policy hooks remain in place.
- Every result has a time-stamped receipt. Missing CLI, incompatible grammar, expired/revoked authorization, missing scope, disabled API, timeout, invalid input/response, and cancellation are not represented as an empty mailbox or successful connection. Newer failures supersede older successful receipts.
- Execution uses a fixed executable and argument array, no shell interpolation. Queries, result size, runtime and IPC inputs are bounded. Raw provider stderr is not shown, to avoid exposing credentials or private output.
- Mail is displayed as plain text, never HTML or remotely loaded images. Model results are explicitly labeled untrusted data. New searches, selections, tab changes, edits and unmounts invalidate older UI responses.
- Calendar query boundaries are explicitly Asia/Shanghai, matching the existing CLI. Timed events retain their offset; all-day exclusive end dates display correctly. Other-timezone model queries must widen the range then filter. Gmail lists are capped at 20, calendar results at 100, and mail body truncation follows the CLI's 4,000 Unicode-code-point cap.

## Write boundaries and actual account state

This change does not add a mail-send or event-create UI/API. The installed CLI has `cal add` but no Gmail send command. Draft-only requests stay drafts; actual event writes remain part of the existing explicit-user-intent Work execution flow. No test sent mail or created, modified or deleted a real event.

The existing account's read-only status check returned `invalid_grant: Token has been expired or revoked` for Gmail and Calendar. Real authenticated mailbox/calendar success therefore cannot be accepted yet. The account owner must review and complete existing `gws auth` themselves before retrying. No login, credential change, permission expansion or production data change was attempted.

## Verification

Focused checks, rather than the unrelated full regression gate, cover the touched CLI/IPC, UI and native-tool boundaries. The six-task live scenario runs actual `pnpm dev` Electron, preload/main IPC, the configured real model, and a real synthetic CLI subprocess under an isolated HOME. It has no production credentials and records every CLI invocation. Categories: inbox search, message reading, reply drafting, agenda query, conflict checking and authorization-failure diagnosis. Failure injection is last, after normal queries and UI flows.

The fixture deliberately includes an inert HTML tracking/script payload. The actual renderer was checked for no created `img`/`script` and no script execution. Screenshots cover mailbox, calendar and auth-required states. Mounted React tests separately cover interrupted/repeated/stale-response flows. These are renderer/preload/IPC tests, not native OS pointer-input acceptance.

The initial live run exposed the model treating older successful reads as current evidence after a new auth failure. Receipt-time guidance and the live assertion now explicitly prohibit that inference. Review also caught and fixed malformed calendar IDs/time ranges and whitespace/emoji truncation boundaries.

System `/tmp` rejected fixture writes with a user quota error despite free space; tests were moved to a checkout-local TMPDIR. No unrelated temporary files were removed.

Not claimed: working real-account access after reauthorization, Windows/macOS desktop runtime, packaged app, full regression gate, actual external write, adversarial-model prompt-injection proof, or a real-model Work execution. The native Work tool wiring is covered by source review and focused policy tests.

### Final results

- PASS: `typecheck` (scripts: 0 errors), `test:google-workspace`, `test:google-workspace-faults`, `test:google-workspace-tools`, `test:google-workspace-ui`.
- PASS: `test:bot-settings`, `test:skill-connector`, `test:connector-id-case` (5/5), `test:mcp-composer-focus` (9/9), `test:work-permissions-retired`, `test:app-permission-ui-removal`, `test:durable-tool-policy`, and `test-all --audit`.
- PASS: final `test:google-workspace:live`, all 6 task categories and 12 model calls using `opendesign/deepseek-v4.1-flash`. Newer auth failure is correctly reported despite older successful receipts.
- Actual existing CLI grammar was verified by one minimal Gmail search and one one-day Calendar read. Both returned `auth_required_invalid_grant`, with no message/event content logged. Real successful account access remains blocked on owner reauthorization.
- No product build/package, installation, version bump, production restart or full regression run was performed. Dev compilation is solely the repository-prescribed `pnpm dev` acceptance path.
