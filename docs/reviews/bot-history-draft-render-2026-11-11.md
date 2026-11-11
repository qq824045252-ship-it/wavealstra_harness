# Long-conversation draft rendering, 2026-11-11

## Scope and measured bottleneck

Baseline **277188267e72ba193e6484cc33c70fd5d479d2af**. This round changes only BotWorkspacePage.tsx in production. It does not change Work search, scheduling/recovery, issue #27, Vivion work, persistence, history pagination, message ordering, permissions or features.

The real Bot page subscribes to the draft and rebuilt every loaded message component for each keystroke, even though the transcript was unchanged. A 1,000-message synthetic history caused 1,000 message renders per input and roughly half a second before a stable frame. The delivered change memoizes the existing transcript JSX and stabilizes its existing open-Work callback with all required dependencies. All DOM nodes and keys remain; there is no virtualization, truncation, delayed message display or new polling policy. The memo avoids computing the transcript in non-conversation/empty views.

Messages, scope, names, Work data, question associations and navigation changes invalidate the memo. Child store subscriptions, context and local state remain active. The renderer's immutable stream/history merge contract supplies new message arrays for actual updates. Static review checked callback closures and these invalidation paths.

## Actual Electron native-input comparison

The actual BotWorkspacePage/store/Markdown components ran in isolated Electron profiles with synthetic 100/500/1,000 already-loaded messages. Inputs use webContents.sendInputEvent with real char events; the controller waits for the controlled draft to contain the expected character and then two animation frames. Five input samples per size are retained. React development Profiler is enabled, so absolute times are diagnostic rather than packaged-release SLOs. Host polling is disabled only in the fixture to isolate renderer costs. No model, private data, history IPC/database or full-product startup timing is included.

| Loaded messages | Before input→stable frame ms | After ms | Before React render ms | After ms |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 72.4 | 38.4 | 35.8 | 2.9 |
| 500 | 272.1 | 37.3 | 157.6 | 1.9 |
| 1000 | 500.9 | 28.8 | 280.3 | 1.8 |

For each input, unchanged message renders fall from the loaded count to **zero**. At 1,000 loaded messages the input median falls **500.9→28.8ms**, about 94%. Complete transcript DOM hashes match between baseline and candidate at all three sizes; each typed character also leaves that DOM unchanged. Raw observations and source hashes are in the adjacent JSON.

This specifically fixes unnecessary rerendering on draft/composer changes. It does **not** fix initial mounting or stream-update costs. A single 1,000-message mount was **2255.9→2309.6ms**; stream-update medians were **524.0→500.3ms**, still rendering every message. A 500-message stream was **263.1→265.8ms**. These variations are retained, not called improvements. Normal history retrieval is bounded to 100 messages; 500/1,000 represent accumulated loaded-history stress cases, not the default first page.

## Behavior verification

The native-input benchmark also verifies changed streamed text and Bot name updates. With the messages array held identical, external-task store updates add/remove the correct message link and image-payload updates render the SVG. Image preview open/close works, and both its local state and expanded communication details survive draft changes. Final screenshots were inspected.

Seven real Electron suites passed:

- History paging: personal/team 100/100/50 pages, three viewport widths, concurrent append, repeated loading, anchor/focus, late image growth, resize, EOF/latest.
- Scroll: concurrent streams, wheel/keyboard reading, queued-frame race, resize/completion, explicit resume and new conversation.
- Concurrent conversation: reverse receipts, out-of-order streams, stable question association, isolated stop, reply reference and segment lifecycle.
- Message actions: three widths, reply, scoped stop, completed/unknown states and no overflow.
- Work conversation: actual message/detail/back clicks, Bot/conversation isolation, focus/scroll restoration, saved artifacts, live status and removed Work/team handling.
- Rename: empty/cancel/duplicate/conflict/save, shared names, persistence and Escape.
- Team removal: scoped confirmation, cancellation, duplicate-click protection and settled restore.

Seven focused checks also passed: bot-report-images-ui (React test, not an Electron suite), bot-message-presentation, bot-conversation-ui, bot-history-paging, bot-history-paging-sqlite, bot-team-conversation and bot-report-images. Full web/node/scripts typecheck passed with zero errors. Independent static review passed.

The previous **476/476** default gate is for parent 27718826. This commit's final full gate is coordinated separately and is not claimed before it runs. No cloud CI, Windows, packaging, provider/network or full-product cold-start pass is implied.

## Remaining investigation

Initial large-history mount and per-message streaming remain measurable renderer costs. Static inspection also found that the existing repository-only history benchmark excludes BotReportImageService hydration; that path reloads message projections and may synchronously snapshot missing report images. Its end-to-end timing was not measured in this round, and its filesystem/security behavior was not changed. Those require separate evidence before another optimization.

## Reproduce

~~~sh
TMPDIR=<short-external-temp-dir> env -u ELECTRON_RUN_AS_NODE pnpm exec electron scripts/perf-bot-history-render.cjs 277188267e72ba193e6484cc33c70fd5d479d2af
TMPDIR=<short-external-temp-dir> env -u ELECTRON_RUN_AS_NODE pnpm -s test:bot-history-paging-desktop
TMPDIR=<short-external-temp-dir> env -u ELECTRON_RUN_AS_NODE pnpm -s test:bot-scroll-desktop
pnpm -s typecheck
~~~

[Public synthetic evidence](bot-history-draft-render-2026-11-11.json).

Report metadata correction: the original runner used the same `baseline` key for the commit and measurements, so the measurement object hid the commit. The runner now emits `baselineCommit` separately. The adjacent JSON adds the verified commit without changing observations or the hashes recorded for the original run.
