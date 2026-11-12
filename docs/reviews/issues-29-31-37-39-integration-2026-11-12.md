# Local integration review: issues 29–31 and 37–39

Base: main 56604474. User working checkout remains untouched. Integration uses individually verified files and selected patches; no account configuration or credentials are included.

## Additional review fixes
- #30: group repeated invocations by Skill and candidate version; repeated reads of the same method no longer cause false ambiguity. Different revisions still require disambiguation. Feedback remains idempotent.
- #31: retain the actual result body when frozen delivery files are present (including an empty array). Attachment transport status is separate from the execution author's claims.
- #31: Discord explicit HTTP 429 uses bounded, cancellable retries with the same request identity, current authorization and Work revision checks. Unknown network outcomes are not blindly resent.
- #37–39: integrate reviewed evidence freshness, persisted review receipts, stage-specific retries, and bounded reply/idle/open/close lifecycle with retained cleanup ownership.

## Current-source verification
Typecheck: zero new script errors. Test classification audit: no unclassified tests.
Passed targeted tests: cross-channel contract, gateway Bot binding, native Bot memory runtime, memory Skill learning, memory Procedure learning, runtime Skill loader (91 assertions), repeated-method feedback, Gateway review regressions, completion recovery (#37/#38 and real process SIGKILL), result lifecycle (#39 real native SQLite with controlled faults), Phase 5 Gateway (19), delivery dedup (43 plus new attachment/closure cases), Discord, DingTalk, QQ and reminders (native Windows file handling).
Some initial ad-hoc bundles used the wrong Electron stub or ESM format; those runner failures were corrected using each test's configured stub/format and are not reported as product passes. Esbuild output was written through its write:false API due this environment denying child-process direct output writes; tested source and dependency resolution remained unchanged.

## Still not claimed
Per latest user instruction, full regression and six-type real-model/end-to-end acceptance are deferred until these issues are integrated. No product build, packaging or user-instance restart. Synthetic transport tests do not prove real Discord/DingTalk account file delivery. QQ general-file delivery remains an explicit unsupported capability. Same-machine resident capability is not an always-online cloud host and cannot execute while its computer is asleep/offline. Previous live evidence is retained in the original plan but is not relabeled as validation of this integrated revision. Issues are not automatically closed by this commit.
