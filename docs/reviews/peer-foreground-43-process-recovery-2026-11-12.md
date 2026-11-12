# #43 independent process-recovery evidence

## Version and scope

Source: `ab5b8967cd182a12a2122a53a03772f45dc9fdfa`, 2026-11-12, isolated Omarchy checkout. Tracked source stayed unchanged. No original user checkout, real account, model network, GUI, product build, package, commit or push was used by this verification. This report does not close #43.

## Actual execution

Six initial and five final-file scenarios each killed a real child process with SIGKILL without graceful service/database close, then started a new process over the retained on-disk SQLite and native Durable directory. All eleven recovery scenarios passed. Four further invalid-source/destination variants also used a killed seed process and fresh recovery process, and passed.

| Group | Verified points | Result |
| --- | --- | --- |
| Recipient foreground | prepared/not admitted; admitted/no receipt; before B decision; Work commit/no tool receipt; foreground reply pending; reply transport failure | 6 passed |
| Final Work file | final report persisted; return outbox; A admitted; A summary completed; transport failure recorded | 5 passed |
| Invalid routes | original A conversation archived and a new A conversation active; source A deleted through BotDeletionService; destination A disabled; receiving B disabled before admission | 4 passed |

The final-file fixture used real production dispatch, generated-artifact registration, submit/accept deliverable and closeWork APIs. Its synthetic execution created actual JSON and frozen-file bytes. Recovery preserved `closed/succeeded`, exact file hash, original human source, unique B request/Work, and a final return identity distinct from the earlier acknowledgment. Repeated report insertion, publish and recover did not create another report. A saw the actual final file reference and original conversation received the corresponding summary; private raw tool text was not inserted into A's chat.

After B completed, recovery did not reinfer B. After A completed, recovery reused A's saved body without another A model call. Transport retries retained the same logical identity; these are calls to a test adapter, not evidence of real external delivery.

Archived/deleted source and disabled destination variants retained the final file/report and recorded explicit recovery errors, with no A summary/inference or transport call after recovery and no final report in the unrelated current conversation. A disabled receiving B retained one prepared request but had no B receipt, Work or schedule.

## Failed diagnostic retained

The first final-file pass failed only at a test assertion using default `listWorks()`, which intentionally omits closed Work. The corrected assertion counts all Work rows for the fixture user. All five were rerun on fresh databases. The initial failed logs remain retained and are not relabeled as passed. No product change was made to make these checks pass.

## Evidence and limits

[Sanitized results and hashes](evidence/peer-foreground-43-process-recovery-2026-11-12.json) identify the exact tested source and probes. Raw process logs, synthetic databases and machine-specific probe sources remain local; they are not part of this repository evidence update. Those scripts still need path portability and test-classification/typechecking work before entering the normal test suite.

Models, backend execution and channel transport are explicit substitutes. This verifies real process/disk recovery of the production foreground and delivery services, not actual Electron GUI main-process crashes, system failures, real-provider behavior, real-channel receipts, or complete all-repository regression. An unknown external success-before-receipt requires its existing transport ledger acceptance, not an inference from these adapter counters. Unified full regression and remaining real UI/account acceptance remain separate.
