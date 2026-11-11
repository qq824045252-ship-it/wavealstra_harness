# Long-conversation stream rendering, 2026-11-11

## Scope and cause

Baseline **1fff1950830dc3885feec41ad9594c555ec05a8f**. The only production change is in `BotWorkspacePage.tsx`; scheduling/recovery, issue #27, Vivion, persistence, permissions, history ordering and scroll logic are unchanged.

A stream frame replaces one message object, but the page previously rebuilt every loaded message. CPU sampling identified repeated React reconciliation, development profiling and message-action rendering; ChatMarkdown already had its own memo. The change applies default React memo to the existing message component in this timeline, keeps unchanged Work-list identity using ordered element-reference equality, and moves per-message action binding inside that component. The Work visibility filter itself is unchanged. Open-Work captures the current conversation ID rather than the entire histories object.

Every prop still participates in default shallow comparison. Message, question, Bot name, Work-object, scope and callback changes invalidate the row. Existing zero-argument callback callers remain compatible; direct uses of the exported BotMessage outside this timeline are not newly memoized. No virtualization, truncation, delayed display, polling change or skipped stream frame is introduced.

## Real Electron measurements

The existing actual-page/store/Markdown Electron harness uses isolated profiles and synthetic histories of 100/500/1,000 messages. Assistant messages each render four Markdown sections and lists, asserted in the DOM. The last reply starts queued; each measured frame uses the real `mergeBotMessageEvent` to enter/continue running. Time covers applying the store change through two animation frames, not model transport, IPC or database work. Each size has five stream samples; host polling is disabled only in the fixture.

Production React mode, without development Profiler overhead:

| Loaded messages | Before stream median, ms | After, ms |
| ---: | ---: | ---: |
| 100 | 32.2 | 28.2 |
| 500 | 60.4 | 30.8 |
| 1000 | 112.6 | 23.6 |

The 100-message result is near the animation-frame floor, so no material improvement is claimed there. At 1,000 messages, this paired run reduces stream time about **79%**. Each frame renders **one** message instead of every loaded message. Draft edits still render zero message rows.

Three additional independent production runs start directly with a fresh 1,000-message history, reversing A/B order in the second run:

| Run | Before stream median, ms | After, ms | Before first load, ms | After, ms |
| --- | ---: | ---: | ---: | ---: |
| 1 | 119.3 | 21.7 | 1831.8 | 1761.8 |
| 2, reversed | 125.9 | 20.5 | 1852.5 | 1764.8 |
| 3 | 124.8 | 21.8 | 1712.5 | 1768.0 |

These reproduce roughly **82–84% less stream time**. First-load medians are 1831.8→1764.8ms, but three observations do not establish a startup improvement. This round targets streaming and does not claim a cold-start fix.

Development Profiler runs in both A/B orders also pass. Their 1,000-message stream medians are 514.6→35.8ms and 526.7→59.5ms. Absolute development timings vary substantially and are retained in the JSON, including slower load observations. In the staged 100→500→1,000 sequence, the last load is a history replacement with existing rows, **not a fresh mount or full-product cold start**: development samples were 2224.6→2356.3ms and 2281.7→3857.2ms; the production sample was 879.4→897.6ms. No improvement is claimed for that operation, and no slower sample was discarded. A prototype extra wrapper component was removed before the final measurements; the delivered memo adds no extra inner message component.

Normal history retrieval is bounded to 100 messages. The 500/1,000 cases represent accumulated loaded-history stress. No private history was used. Public raw samples, source hashes, fixture hashes and run order are in the [adjacent evidence JSON](bot-history-stream-render-2026-11-11.json).

## Equivalence and UI verification

All six final A/B runs passed:

- Exact initial transcript DOM hashes match at every tested size. Every typed character leaves that transcript unchanged.
- Every streamed transcript hash matches after normalizing the independent generation-speed leaf's time-dependent content and useId. Its clock advances independently, and changed usage/speed values have separate assertions; the hash is not claimed as a speed-label equality test.
- One changed message renders one row; a changed source question renders itself and its reply. Unchanged Work objects in a new array render zero rows; reordered Work objects invalidate all ten boundary-test rows.
- Work titles, removed Work fallback, deduplicated question/reply links and result attachments refresh while the message object is held fixed.
- queued/unknown/failed/cancelled/completed actions update correctly. Reply and cancellation callbacks retain their precise message targets.
- External-task and image-payload subscriptions update beneath memoized rows. The image test first proves the payload is absent, then checks the generated blob image.
- Communication folds, progress folds and the image preview retain identity/state while another message streams. Bot rename remains visible. Final real-window output was inspected.

Seven real Electron suites passed: history paging, scroll, concurrent conversation, message actions, Work conversation/navigation, rename and team removal. They cover personal/team paging and history anchors, wheel/keyboard/resize/resume, concurrent and out-of-order replies, scoped stop/reference, navigation back/focus, saved file paths, stale/foreign/removed Work and team boundaries, and interrupted/repeated UI flows. The latest Work-navigation font/error-gate fixes are preserved.

Nine focused tests passed: bot-report-images-ui, bot-message-presentation, bot-conversation-ui, bot-history-paging, bot-history-paging-sqlite, bot-team-conversation, bot-report-images, bot-call-thread and bot-work-phase5-review-ui. The first is a React test, not an Electron suite. Web/node/scripts typecheck has zero errors. Independent static review checked callbacks, every call site and immutable store-update paths.

The full default gate for this new source change is delegated for after publication and is not claimed here. The earlier 476/476 result belongs to the parent source. No Windows, cloud CI, packaging, artifact gate, live-provider/network or complete application startup pass is implied.

## Remaining limits

Fresh mounts still create all loaded DOM nodes. Replacement/polling snapshots that contain new objects can still rerender those rows; Work updates conservatively invalidate all rows using that Work list. Main-process history hydration and synchronous image/file work are outside this patch. Those need separate end-to-end evidence before another optimization.

## Reproduce

Run from the repository with a short external temporary directory. These compile only the test fixture, not a product build.

~~~sh
TMPDIR=<external-temp-dir> BOT_HISTORY_PERF_MODE=production env -u ELECTRON_RUN_AS_NODE pnpm exec electron scripts/perf-bot-history-render.cjs 1fff1950830dc3885feec41ad9594c555ec05a8f
TMPDIR=<external-temp-dir> BOT_HISTORY_PERF_MODE=production BOT_HISTORY_PERF_COUNTS=1000 BOT_HISTORY_PERF_REVERSE=1 env -u ELECTRON_RUN_AS_NODE pnpm exec electron scripts/perf-bot-history-render.cjs 1fff1950830dc3885feec41ad9594c555ec05a8f
TMPDIR=<external-temp-dir> env -u ELECTRON_RUN_AS_NODE pnpm -s test:bot-history-paging-desktop
TMPDIR=<external-temp-dir> env -u ELECTRON_RUN_AS_NODE pnpm -s test:bot-scroll-desktop
pnpm -s typecheck
~~~

Omit `BOT_HISTORY_PERF_MODE` for development React. `BOT_HISTORY_PERF_OUT` selects the diagnostic output directory. `BOT_HISTORY_PERF_REVERSE=1` reverses A/B order; omitting it uses baseline first. Production mode reports zero React Profiler durations because that instrument is disabled, not because rendering takes zero time.
