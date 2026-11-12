# #32 fresh default foreground workspace follow-up

## Reproduction

Fixed base `f8aa5c8dc14a2a3bcab86a549928e6735088b9f1`; real Electron/Magpie A–F run `2026-11-12T17-35-56-624Z`. Case A failed after seven real requests: `bot_organize discover/arrange`, `work_query_status` and `fetch_content` all failed at the native cwd realpath check. The product-managed default primary-Bot directory did not exist. B depended on A's target and consequently failed. C was interrupted; D–F were not accepted as tested. Only the owned fixture app/driver were stopped after this common prerequisite failure was proven, rather than spend more model calls on invalid follow-up cases. This is not a passing batch.

The foreground uses captured settings to preserve its original configuration. That path short-circuited `botWorkspace(botId, true)`, the existing preparation call. Settings capture/discovery deliberately does not mutate the filesystem. As a result, a fresh Bot could start a model turn but all real tools failed. The successful #43 six-case run explicitly selected existing fixture folders, so it did not cover this fresh-default case.

## Narrow correction

At actual foreground runtime opening, captured settings now go through the settings service's workspace preparation. Only its identity-matched product-managed default folder is created. An explicit custom folder is validated, never recreated. Frozen old settings continue to use their old folder if the current Bot configuration changes. Discovery/capture remain read-only; Team workspace resolution is unchanged. No ACL, permissions or global cwd changes.

## Targeted evidence

A regression removes the fixture B directory and requires its frozen workspace to be prepared before composer/native execution. Before the fix the real foreground never reached B's model barrier; after the fix all 16 existing peer-ingress behavior groups passed. This uses real AppDatabase and the existing controlled provider, not a real external model.

Bot settings checks verify default capture does not create folders; execution does create the managed default; a different default identity is rejected without creation; a missing explicit custom folder is not recreated; and a queued frozen default remains independent of later custom settings. `test:bot-settings` and `typecheck` passed. Full regression and real A–F rerun remain pending. Original failed reports/traces stay local; no user data were changed.

## Driver contract correction before the next batch

The subsequent `895b2e84` run `2026-11-12T17-45-01-413Z` reached real organization creation/admission, confirming the default-directory fix. It exposed an old driver premise: immediate Work assertion after A admission. B had not yet made its foreground decision. A failed prematurely and its later asynchronous Work contaminated B's global count. This batch remains failed/interrupted, not a product regression or a successful rerun.

The driver now observes a persisted B receipt plus actual Work linkage; absence of Work remains pending inside the existing overall deadline. It still requires successful Work closure, exact files and ownership, and now explicitly waits for A's completed return correlated to the current report. Pure consultation waits for B's real reply and A return before checking no additional Work. Separate contact lookup uses exact source/target identity without presupposing a Work. The concurrent fault hook similarly waits for B's actual decision. A failed prerequisite aborts later cases as not run rather than contaminate their counts. No product behavior, deadline or success criterion was relaxed. Pure driver tests cover pending receipt, actual link, nonterminal Work and missing receipt rejection.

## Actual UI navigation verified without a new model run

The failed inline-control assumption was investigated using a copy of the same persisted test database. Model transport was explicitly disabled and no provider request was attempted. From A, the real collaboration summary/history opens the linked personal Work; its **Open saved version** control successfully reads the original saved artifact. The visible JSON equals the saved JSON (total 166, original marker, SHA-256 `b57b5366b7ba529f01ce6c5ad82f0e1aab71fbc7a056ee4766f6fb1a04cd7b1d`). This is an available product path, not missing file delivery.

The driver now follows source collaboration history → exact collaboration ID → linked personal Work → saved-file preview → return to source. Its exact extracted navigation/preview function was run against that real persisted UI and passed visible-content comparison and actual `workspace:readFile` receipts; no RPC fabricated content. Navigation uses CDP mouse events and checks hit-testing after layout settles. The navigation phases share the original 300-second file-control deadline. File existence, saved-version identity and visible-content assertions remain. No product code changed. [Sanitized UI evidence](evidence/bot-organization-32-ui-path-2026-11-12.json). This UI-only check does not turn the earlier A–F batch into a pass; a new full batch is still required.
