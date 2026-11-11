# Gmail and Calendar write integration

Extends the read-only integration published as `bf7591f6b9656849597569b0869d0fa8806e1d2b`.

## Scope

- Reuses the installed custom Python `gws` runtime and its existing authorization. No login, token copying, additional OAuth scope, installation, or credential-file inspection was performed.
- Adds explicit plain-text Gmail sends, Calendar creates (timed and all-day), and edits of a known non-recurring event.
- Bot native tools and the mailbox/calendar forms use the same backend. Merely drafting does not send. Forms submit only from the user's send/create/save action; there is no second redundant approval dialog.
- Event edits first read the latest event/etag, patch only changed fields, and use `If-Match`. Existing attendee metadata is retained for unchanged participants. Notifications require explicit invite/change-notification intent.
- The bridge is fixed, bundled Python source. It discovers only the known two-line local `gws` wrapper, uses its Python and module directly, sends JSON over stdin, and never evaluates wrapper shell text or user arguments as shell commands.
- Gmail MIME is constructed with Python's email library, an authenticated sender, and a stable operation-specific Message-ID. SDK retries are disabled. Calendar times and timezone are checked, including all-day exclusive end dates and nested PATCH date/dateTime conversions.

## Duplicate and uncertain-outcome protection

- Each write is journaled before dispatch with an exclusive, fsynced file. Journal filenames and content hashes do not expose message text, recipients, event title, description, or credentials. Only minimal result identifiers/time boundaries are retained.
- A repeated successful operation returns its receipt. A pending/unknown operation is never automatically replayed. A definite no-effect failure can be retried explicitly with the same operation key.
- Native operations derive their stable operation key from trusted original user request scope, action, and canonical parameters, not a model-selected key or tool call ID.
- A persistent request-scope barrier blocks fresh operation IDs, changed payloads, other write actions, and restarts after an uncertain effect. Frontdoor and derived Work must share validated original input identity. Missing trustworthy identity fails closed.
- UI double-submit is synchronously locked. Pending/unknown drafts survive page navigation and component remounts in memory. Cancelling an unsubmitted draft causes no write; leaving after submission does not undo it.

## Verification

All write tests use synthetic, isolated services/account data. Real Google mail/events were not written.

- Backend synthetic checks cover MIME, injection, explicit notification scope, etag conflict, attendee metadata, dates, nested PATCH conversion, journal restart/concurrency, exact-failure retry, timeout/cancellation, unknown scope across operation/action/restart, and journal privacy.
- Mounted UI checks cover invalid inputs, explicit submit, duplicate submit, auth failure retry identity, unknown navigation/unmount, fresh etag, guest preservation, conflict rebase, plain-text rendering, and all-day/timed creation.
- Native tool checks cover host-derived request identity across tool calls, different requested payloads, missing-identity rejection, runtime read-only checks, unsafe replay metadata, and changed-fields-only updates.
- Real Electron development UI and real-model acceptance use an isolated HOME, fake `gws` Python SDK/CLI, and an existing local model gateway. They do not seed production credentials. Actual renderer, preload, main, Python bridge, and receipt UI are exercised; CDP interaction is not an OS pointer/keyboard validation claim.
- Real-model categories: draft without sending, explicit mail send, timed event, all-day event, title-only edit, and event invitations. Post-send response-loss injection runs last as a seventh category and must produce exactly one synthetic effect and an honest uncertain answer.
- The initial live run passed six normal categories and UI checks. The final fault was correctly handled, but its text assertion did not recognize “结果未知/不能确定”. The assertion was corrected. A later review also found call-ID-only deduplication insufficient; request-level identity/barriers were added before final acceptance.

Final acceptance passed with `opendesign/deepseek-v4.1-flash`: seven categories, 16 actual model calls. The last fault answer explicitly reported `outcome=unknown`, used read-only verification, did not claim a failed send, and did not repeat the write. The synthetic SDK recorded exactly one effect for that case.

Passed commands:

- `pnpm -s typecheck`
- `test:google-workspace`, `test:google-workspace-tools`, `test:google-workspace-ui`
- `test:google-workspace-write` (17 backend groups), `test:google-workspace-write-tools`, `test:google-workspace-write-ui`
- `test:google-workspace-request-scope`, including actual current-schema AppDatabase, BotConversationRepository.accept, WorkService.createWork/dispatchExecution, retained-input amendment, new-user-input amendment, and stale-binding rejection
- `test:bot-settings`, `test:bot-conversation-ui`, `test:work-execution-metrics`
- `test:durable-tool-policy`, `test:durable-tool-gate`, `test:work-permissions-retired`, `test:app-permission-ui-removal`
- `test:mcp-composer-focus`, `test:skill-connector`, `test:connector-id-case`
- `test:google-workspace-write:live` (actual Electron development app and real model, isolated synthetic Google services)
- `node scripts/test-all.mjs --audit`: classification passes, 462 headless / 86 GUI / 41 NETWORK / 3 DATASET / 3 ARTIFACT, no pending entries. This is a classification audit, not a full-suite run.
- `git diff --check`
- Final fault gates: `test:google-workspace-write` and `test:google-workspace-faults` passed after the remaining normal checks.

Local generated evidence: `out/diagnostics/google-workspace-write/live/report.json`, `provider-requests.json`, and mail/calendar screenshots including `*-receipt.png`. Screenshots were visually reviewed; disabled completed forms, receipt IDs, unchanged content, and edit results are visible. Generated evidence and isolated profiles are not committed.

## Boundaries

- The previously checked real account returned `invalid_grant`. The user must restore their existing authorization themselves before real mailbox/calendar use can succeed. The development work did not alter authentication.
- No successful real-account send/create/update is claimed. Synthetic integration proves the product call path, not live Google delivery.
- Supports this user's known custom Python `gws` wrapper, not arbitrary executables named `gws`. Unsupported runtimes fail explicitly.
- No attachments, recurring-series edits, delete operation, arbitrary MIME, or local persisted email drafts. Identical action/parameters within the same original user request are deliberately one operation; repeated autonomous cycles need their own trusted user input identity and are not implemented here.
- No product build, package, install, shortcut change, or production app restart. Focused risk-based tests were selected instead of the entire regression suite.

## Official API references

- https://developers.google.com/workspace/gmail/api/guides/sending
- https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
- https://developers.google.com/workspace/calendar/api/v3/reference/events/patch
