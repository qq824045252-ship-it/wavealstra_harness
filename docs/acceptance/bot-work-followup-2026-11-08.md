# Bot Work follow-up: reports, review controls and recovery guidance

## Scope

This follow-up starts from main `c30e306ef8f586fc8bb846add40b0707a168e145`. It addresses duplicate native completion reports, explicit review/criterion controls, actionable waiting-input blockers, safe shell recovery guidance and conversation noise. Existing Work, execution/evidence records, approval decisions and Bot history are retained.

## Behavioral changes

- A completed binding's summary is omitted from its status notification only when the exact native aggregate `result:<bindingId>` has the same binding, owner epoch, input/intent version and identical body. Partial results, different member outputs, unknown/stopped outcomes and distinct diagnostics remain recorded and available.
- Host-generated feedback has additive structured metadata. Ordinary progress and superseded event versions are folded in the conversation. Latest decisions, unknown effects, current results and closure remain visible. Expanding a fold exposes the original messages in order. No message text is used to infer urgency; unclassified historical messages remain visible.
- Metadata is backfilled against exact host-generated delivery identities without replaying messages, changing their bodies or resetting the database schema version. Fake feedback-looking user request IDs cannot suppress real feedback or relabel ordinary model replies.
- Review separates result adoption, evidence-backed ordinary criterion verification, real-environment feedback and explicit closure. Executing a task does not satisfy criteria or accept a result. A required environment is enforced even when the old boolean flag is absent.
- Edited review evidence remains attached to the version the user reviewed. Background changes and other successful controls do not silently rebind it. Rebinding requires an explicit latest-state acknowledgment. Uncertain transport retries keep the original operation and snapshot.
- Typed information replies record the exact question, user answer and evidence. They do not grant scope, reconcile unknown effects or restart execution. Terminal denied/expired/invalidated approval blockers no longer falsely advertise an available approval decision, including recovery of existing records.
- Legacy owner information reports can be answered only when their original control hash is reconstructable, one receipt maps to one historical blocker row (including cleared rows), owner/input/intent remain unchanged, and no approval/resource/budget/effect reference exists. The user explicitly confirms that it is only an information question and supplies an answer plus evidence. The response records the original receipt and snapshot, clears only this blocker and does not dispatch execution.
- Legacy questions without sufficient provenance retain a safe, unsent owner-conversation draft action. It preserves both Bots' existing drafts and the original blocker. It is not a generic clear-blocker action.
- Resource refusals explain safe recovery: exact-path built-in `read`, then scoped `write`/`edit` after rereading the actual target, or single-path `ls "./dir"` without flags. Adding a path does **not** make `wc -l`, `ls -1`, or arbitrary shell commands trusted. The tiny parser and resource safety rules are unchanged.

## Validation boundaries

The earlier Omarchy report belongs to the user's `b688530` baseline. It is not evidence for this follow-up. The previously restricted cloud AT-SPI private-socket test is not retried through another route, and no baseline is changed to hide it. Production packaging/build is not part of this task; UI checks use isolated development data and do not touch the user's Work.

Typed question creation remains a service-level API; this change does not add foreground model tools. A seeded real-service UI fixture verifies that service/UI path and must not be described as an online model spontaneously creating a question.

## Checks performed

- Final `pnpm -s typecheck`: web, main and scripts passed; scripts reported zero errors and zero baseline errors.
- Official default inventory: 392 headless tests. The 391 permitted tests were run through disjoint official `test:all --filter=... --jobs=1` groups. The previously restricted `test:atspi-transport` was explicitly not attempted. First pass: 389 passed, two failed.
  - `architecture-graph` detected that the added controls exceeded WorkService's file-size cap. Report/reply mutation bodies were extracted into `WorkUserInputControls.ts`; the transaction, actor, version and receipt wrappers remain in WorkService. The final file has 2,497 lines. Architecture checks passed after extraction; no limit or baseline was relaxed.
  - `project-materials-dom` initially timed out waiting for its document editor. After the isolated GUI was stopped, its standalone rerun passed without source, timeout or baseline changes. This first-pass failure is retained in the record; it was not an uninterrupted all-green run.
- Final post-extraction checks all passed: project-materials-dom, architecture-graph, work-conversation-feedback, bot-work-phase5-review (20 cases), bot-work-phase5-review-ui (21 cases), work-approval-native, bot-workspace and full typecheck.
- Resource-gate and durable-tool-policy regressions passed, including executor-visible guidance persisted through SQLite reopen as a blocker and `not_started` partial result. Scoped reread permits only the actual scoped target; flags and arbitrary shell remain refused.
- Feedback coverage includes exact aggregate body deduplication, independent same-text member results, partial/unknown/stopped diagnostics, original archived conversation routing, blocker clearing/reopening, transaction rollback, restart, retry polling, authority checks, metadata upgrade without Work reset and forged feedback-looking request IDs.
- Independent code review checked the retained-draft version pin, diagnostic preservation, legacy forward/reverse provenance uniqueness and the final helper extraction. The review did not substitute for the execution tests above.

## Real desktop validation

The actual Electron application ran using `pnpm dev` with an isolated QA HOME and database. A temporary, uncommitted development config externalized heavyweight installed SDKs to fit the cloud memory budget; no product build configuration, packaging or user data was changed. Fixtures were created through real Work services. This was not an online-provider/model test.

Observed through the actual UI and persisted database:

- Adopting a proposed result left the ordinary criterion pending; explicit evidence-backed verification changed it to satisfied.
- A typed information reply cleared only its question and preserved the answer/evidence. Explicit closure then produced `closed/succeeded`.
- A proven legacy owner question required the information-only checkbox before saving. Its original receipt and source snapshot were retained. Reply alone did not adopt the proposed result or pass the criterion. Explicit adoption, verification and closure succeeded afterward.
- A question without provable source opened an unsent owner draft and kept its blocker. Required-environment criteria had no ordinary-attestation shortcut; environment alone did not enable passing without a source/version record.
- Result cards now clearly label their saved unverified scope as the state **when that card was created**, rather than contradicting current criterion progress.
- Latest decisions/results remain visible while ordinary feedback is folded. Scrolling within the loaded history and explicitly returning to latest worked. The history view remains bounded to its existing 100-message window; no older-page UI coverage is claimed.
- The final main bundle was rebuilt after helper extraction and the application restarted. Both completed QA Works retained their accepted, satisfied and succeeded states, and the unsent draft was retained. The owned Electron process was then stopped.
- Archive cancellation was exercised. Final archive confirmation was not executed; no full archive-UI success is claimed. Durable archived-origin routing was verified separately by the feedback regression.
