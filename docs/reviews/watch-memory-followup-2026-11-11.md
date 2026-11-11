# Standing Watch memory follow-up

## Isolated reproduction

Omarchy, real desktop-session `pnpm dev`, synthetic files and a temporary HOME only. The production instance, production data and the vivion computer were not changed. No build/package or crash injection was used.

The previous run had stopped on a renderer CDP query timeout. On the resumed desktop-session run at `8f424d6`, six task types each completed three selected real timer executions: inventory total, open todo count, earliest meeting, Celsius-to-Fahrenheit conversion, project-state summary and expense total. Each retained one Work memory ID across distinct execution task IDs. Natural correction and deletion removed the obsolete Bot memory evidence, and all six watches were paused at the end. The former renderer timeout did not recur in this run.

The old runner said `passed`, but manual inspection found two semantic failures that its assertions missed:

- Three first-round native summaries claimed no change without any prior report. The expense foreground summary repeated that unsupported comparison. Persisted native inputs and foreground review contexts both had empty history, so this was not current-result self-inclusion.
- After forgetting the two known suffixes, three native outputs invented replacement suffixes. The foreground summaries correctly omitted them. Merely checking that the two old strings were absent was insufficient.

The strengthened live assertions reject the captured failures. The rerun adds a fourth actual timer phase with unchanged files, verifying that a genuine unchanged observation is still reportable rather than banning all comparisons.

## Fix boundaries

- Work snapshot repair accepts only a verifiable automatic candidate takeover of the same Work. It preserves the audit trail and does not revive user-deleted, manually edited, detached or foreign-source records.
- Current native Work preference state is bounded, scoped and separate from historical facts. It contains current L1 references, not a second preference database or deleted text. A generic instruction to follow current preferences does not authorize inventing a missing format. Historical reports and snapshots remain factual history.
- Comparison state is independent of notification silence. An initial silent baseline is not proof of unchanged content. Native and foreground history must precede the current execution and match its owner, input and intent identities. Missing history must not be fabricated from the current result.

## Verification status

The final integrated check and real-model rerun results are recorded below after completion. The initial run is not accepted as semantic success, and no year-long uptime or crash-recovery claim is made.

### Integrated rerun at `5db673a`

The six first-round native and foreground reports correctly described an absent baseline. All six correction rounds used the updated preference. All six forgetting rounds omitted both former suffixes and invented replacements, while retaining stable Work memory IDs. The old renderer timeout did not recur.

The fourth round exposed a new over-conservative result-review behavior: identical complete same-path read receipts were available, but some foreground replies treated `unverified` as a ban on comparison. Todo explicitly refused to confirm unchanged content despite identical third/fourth raw text and SHA-256. The first stopping assertion also failed to recognize the valid phrase “两者数值一致”; that fixture bug was corrected without accepting the independent todo regression. This run was not published as a successful four-round acceptance.

The follow-up supplies bounded prior native read evidence separately from current stop-condition evidence and clarifies that lack of automatic structured comparison does not prohibit grounded numerical/text comparison. Final acceptance still requires a fresh complete six-type rerun.

### Follow-up implementation at `edd8451`

Historical native comparison evidence is a separate package with at most eight current matching sources and at most 16KiB for the complete UTF-8 serialized package. Overflow omits the entire package with an explicit reason. Relative file paths use the source execution's own workspace; a newer failed alias cannot recover an older successful read. The package retains source read times independently of report time and participates in the result-review cache fingerprint. Historical text never becomes current stop-condition proof.

Focused validation passed: typecheck (including zero script errors), durable projection, context ledger, memory assistant scopes, memory cognition, memory projection deletion, Work memory capture, Bot Work review memory, Bot Work review projection (7 scenarios), Watch creation, Watch supervision, Watch goal (31 cases), conversation feedback, team Watch evidence, Bot Work team Watch and architecture (278 passed, 0 failed). The final source-level follow-up reran typecheck, supervision and team evidence. Expected failure-path messages in supervision tests are asserted retry cases, not unhandled suite failures. No local full/default suite, packaged-artifact gate or crash-injection acceptance is claimed.

### Final real-model acceptance at `edd8451`

Passed on Omarchy with `opendesign/deepseek-v4.1-flash` through the local model service. Six task types each completed four real UTC timer rounds at 04:24, 04:26, 04:28 and 04:30 on 2026-11-11. The driver exited 0 after saving screenshots and cleaning up its own Electron instance.

- 24 completed execution bindings, 24 delivered foreground reviews and 24 distinct execution task IDs.
- Six stable Work memory IDs across all four rounds. All six watches remained active during observation and were paused through the foreground interface after acceptance.
- First round correctly lacked comparison history. Correction used the new suffix. Deletion removed old Bot L1 preference evidence and neither old nor invented replacement suffixes reappeared in native or foreground results.
- Fourth-round unchanged inputs were reported as unchanged with grounded facts, including todo count/detail, without the prior mechanical host-verification refusal.
- Five types supplied complete native `read` receipts. Their third/fourth source paths, raw text and SHA-256 matched, and foreground contexts contained the bounded prior package. Expense used actual read-only `bash` calls (`cat`, `awk`, `md5sum`, `stat`) instead of the named `read` tool; its tool responses confirmed the totals and unchanged bytes. Its raw-read comparison package correctly remained unavailable, so it exercised comparison using concrete previous reports rather than falsely receiving native read proof.
- The older renderer/CDP timeout did not recur. Background automatic memory extraction logged some empty/truncated model replies; these did not block the explicit preference changes, persistent Work snapshot checks, 24 completed observations or 24 foreground deliveries. This run does not establish that every background extraction call succeeded.

Local artifacts: `out/diagnostics/bot-watch-memory/live/report.json`, `provider-requests.json`, `watch-memory.png` and `dev.log`. Previous failed attempts remain archived beside the live directory. Temporary fixture HOME: `/tmp/bot-frontdoor-live-He6NNq`. Console log: `/tmp/watch-memory-four-round-final-20261111-1221.log`.

The existing production Electron main (PID 79495 at verification) was not stopped, restarted or replaced. Source-only synchronization does not imply that this already-running process has loaded the new implementation. No change was made to vivion, release packages, application version or production database. Crash/fault injection remains deferred.

### Integration after the live run

Remote `main` advanced to `0394eda` during acceptance. The Watch commits were rebased without conflicts; their preference/Work source contents are unchanged from the live-tested code. Final integrated typecheck, Watch supervision, durable projection and Bot Work review memory passed. The newly added host read-command suite exposed a Windows-specific fixture assumption that directory `stat.size` is zero. The assertion now compares with the fixture directory's actual filesystem size; no runtime change was needed. On Omarchy the suite then passed 16/16, including both symlink-boundary cases and hardlink rejection, with no skips.

The final integrated commit has focused verification, not a second full four-round model run after the unrelated diagnostic merge. Production source synchronization retains the user's untracked files and does not replace the running main process.
