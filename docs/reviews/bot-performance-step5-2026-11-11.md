# Bot performance step 5: measurements and bounded history reads

Date: 2026-11-11. Final validation base: **11576a703f998c96cd3c2f7835a4e8096a41c46b**, plus the history-query change in this commit. The user’s billion-context integration is preserved unchanged. Earlier responsiveness measurements are separately identified as baseline **2764bc6a0760ead3480196fd7f0bacedfe2008fc**.

## Delivered change

BotConversationRepository.history previously merged direct messages and linked inbox feedback with one OR predicate. SQLite could scan unrelated messages in global ordinal order when opening an older conversation. The final change adds an additive (conversation_id, ordinal) index, queries disjoint source pages, and keeps the globally ordered first 101 rows. When 101 candidates exist, it tightens the next source’s ordinal bound, skipping historical inbox records that cannot enter the page.

No schema-version bump, database discard, scheduler/priority change, Work recovery change, context-manager change, production-data access, crash injection, product build or packaging. Cross-Bot inbox feedback retains the original user/work/conversation checks.

## Whole-API comparison

The exact previous implementation and final implementation run against the same synthetic database. These medians include DTO mapping, not just SQL. Small-sample p95s remain in the JSON; shared-machine measurements are not service-level guarantees.

| Fixture | Before, ms | After, ms |
| --- | ---: | ---: |
| mixed-small | 11.17 | 11.26 |
| 50k-messages-sparse-feedback | 19.31 | 11.14 |
| 60k-messages-10k-feedback | 10.91 | 12.43 |
| 60k-messages-100-extra-inboxes | 11.11 | 12.54 |
| dense-inbox-only-10-related | 18.59 | 11.74 |
| dense-inbox-zero-related | 17.99 | 14.50 |
| latest-101-direct-old-dense-inboxes | 10.89 | 10.83 |
| earliest-101-direct-later-dense-inboxes | 10.57 | 11.17 |
| 60k-messages-no-feedback | 12.45 | 10.51 |

The representative 50k sparse-history case improves about **42%**, 19.31 to 11.14 ms. It is not a universal speedup: dense-feedback and 100-inbox cases add approximately 1–2 ms. An earlier feedback-driven UNION was rejected because it regressed dense feedback; its SQL-only 55x result is not the delivered improvement.

212 differential checks cover personal/team/active/archived conversations, ownership, changed team execution Bot, cross-Bot linked feedback, duplicate links, inbox itself, both cursor directions, valid 100-ID requests, 100 inboxes, and newest/oldest full direct pages. Captured parameters and EXPLAIN verify bounded index ranges. First index creation on a 60,430-row synthetic disk database took 40.88 ms in one local sample; schema version and records remained intact.

## Real model, caching and cancellation

Final run: actual opendesign/deepseek-v4.1-flash through the existing local gateway, with published context/output limits, isolated HOME and pnpm dev Electron headless renderer. These are real renderer/IPC/model tests, not native desktop-input or packaged-app acceptance. Each segment has six different task types. No injected provider delay or crash.

| Sequential task | End-to-end, ms | Provider cached / prompt tokens |
| --- | ---: | ---: |
| extraction | 6979 | 24576 / 24654 (99.68%) |
| calculation | 3739 | 24576 / 24772 (99.21%) |
| translation | 4952 | 24704 / 24860 (99.37%) |
| classification | 5069 | 24832 / 24953 (99.52%) |
| summarization | 4933 | 24832 / 25058 (99.10%) |
| planning | 5126 | 24960 / 25164 (99.19%) |

All five follow-on requests retained the exact previous wire-message prefix; reported cache ratios were **99.10–99.52%**. The first request was provider-warm, not a cold-cache measurement. The earlier batch also retained all five prefixes, but one provider hit ratio fell to 40.71%. Stable local prefixes do not guarantee upstream cache residency or routing.

In the final six-request burst, the first three ordinary same-conversation requests entered the provider in 330–372 ms. A status/control request used reserved capacity in **336 ms**; another Bot entered in **335 ms**. The fourth ordinary short arithmetic request waited **10,556 ms** under saturation. This finite burst demonstrates isolation and reserved capacity, not starvation freedom. Fairness/priority redesign belongs to user-owned issue #27 and was not changed.

Selected real in-flight cancellation: **14 ms** to the persisted cancelled event, **55 ms** to API return, **27 ms** to local recording-proxy connection close. All five siblings completed. Proxy close is not proof the upstream provider immediately stopped compute or billing.

The earlier 2764bc6a responsiveness batch passed six classes: direct answer, arithmetic, public web lookup, persistent memory recall, planning and Work delegation. Visible host receipts took 535–600 ms; actual model prose first appeared after 3.29–12.57 seconds. Simple answer/arithmetic/planning each used one foreground inference. The Work succeeded, persisted reload matched, and request-specific cancellation passed. These earlier numbers are not measurements of the final context integration.

## Growth and remaining bottlenecks

The final current-product synthetic growth run uses 1k/10k/50k message and Work rows. Its beginning may briefly overlap typecheck; one run is reported, not a latency SLO.

| Rows | Old conversation, ms | Uncached Work summary, ms | Work search, ms | Cached summary, ms |
| --- | ---: | ---: | ---: | ---: |
| 1000 | 10.63 | 9.89 | 21.64 | 0.30 |
| 10000 | 9.62 | 40.35 | 127.65 | 0.26 |
| 50000 | 9.62 | 177.11 | 573.06 | 0.22 |

50k message rows occupy **35.56 MiB**; adding 50k Work rows gives **55.56 MiB**, after WAL checkpoint. Includes schema/index overhead; excludes attachments and other Durable stores.

In the final six-turn large-prefix live fixture, app.db logical allocated pages grew from 2,543,616 to 3,538,944 bytes. Six request snapshots retained **389,963 UTF-8 context bytes + 466,070 transcript bytes**. WAL size is recorded separately, not mistaken for retained live-data growth. This short run demonstrates snapshot duplication; it does not establish long-run growth or compression at the model limit.

Remaining measured costs: Work summary cache misses compute exact status/filter counts across matching records; 50k search costs about **573 ms** synchronously. Cache hits are about 0.22 ms. DTO mapping and many inbox sources also remain costs. Snapshot retention/compaction, relevant-domain cache invalidation and scheduling need separate correctness work; this patch does not claim to fix them.

## Reproduce and verify

Use an isolated writable TMPDIR with available quota. No real ~/.mybuddy profile is needed.

~~~sh
TMPDIR=/path/to/isolated-tmp pnpm -s test:bot-history-query
TMPDIR=/path/to/isolated-tmp pnpm -s perf:bot-history
TMPDIR=/path/to/isolated-tmp pnpm -s perf:bot-database
BOT_WORK_DEV_HEADLESS=1 TMPDIR=/path/to/isolated-tmp pnpm -s perf:bot-foreground
~~~

The default test:bot-history-query is correctness-only. Large timing passes remain explicit perf commands, outside default test-all.

Passed: full typecheck; 212-check history query; bot-history-paging-sqlite; bot-team-conversation; bot-history-context; bot-work-phase2; cache-boundary-matrix; pi-cache-protocol; durable-context-management; test-all classification audit; final real-model cache/concurrency batch; diff whitespace check. The aggregate **472-test** headless suite, GUI/packaged gates and crash injection were **not run**. GitHub verify was **disabled_manually** when checked; no CI pass is claimed.

[Synthetic-only measurement data](bot-performance-step5-2026-11-11.json). Detailed local evidence: out/diagnostics/performance-step5/; earlier responsiveness: out/diagnostics/bot-responsiveness/live/. Raw prompts, answer bodies and profile paths are omitted from the committed JSON.
