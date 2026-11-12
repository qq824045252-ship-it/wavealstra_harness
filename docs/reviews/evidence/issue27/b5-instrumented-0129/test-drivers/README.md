# Issue27 phase probe handoff, 2026-11-12

All scripts are independent diagnostics. Product source and existing harnesses were not edited. The application checkout remained b5c1429d77d2d2f192149c48a92990cca8f4926c, with only its pre-existing untracked node_modules entry. No build/pack, model calls, direct business DB writes, user-profile reads, configuration changes, permission changes, or broad process termination were performed.

## Integration

Set ISSUE27_PROBE_BOOTSTRAP=/home/vivion/iq27-tmp/p27-1112/bootstrap.cjs for /home/vivion/iq27-tmp/instrumented-prep/runner.cjs. The adapter sets NODE_OPTIONS=--require=.../main-probe.cjs plus IQ27_PROBE_HOME and IQ27_PROBE_OUT only in the dev child environment, starts the collector before the scenario, stops it in the scenario finally block, checks the Chromium dataLoss flag, and checks instrumentation hashes before/after. It uses the harness's own rpc, evaluate, socket and out. The composed frozen-source harness passed --check-harness. No inference was run by that check.

The main preload requires all of: Electron, process.type browser, not ELECTRON_RUN_AS_NODE=1, HOME equals IQ27_PROBE_HOME, and a profile under /home/vivion/iq27-tmp. The final exclusion check ran ordinary Node and Electron-as-Node and produced only their requested stdout, with no new probe logs. An explicit HOME guard failure disables hooks.

The standalone collector exports start({rpc,evaluate,out,socket}) -> {calibrate, stop}. Use start after Bot preload is ready and before measured input; stop before Browser.close. Current collector writes trace event chunks directly to disk rather than retaining the entire trace in the runner heap. Do not run two collectors on the same browser. A browser restart needs a separately stopped/new collector and output directory.

Offline analysis: node --max-old-space-size=3072 /home/vivion/iq27-tmp/p27-1112/analyze.cjs EVIDENCE_DIRECTORY

## Scope and event semantics

- SQLite: wraps actual better-sqlite3 native Statement.run calls, preserving this, return values, Promise-free synchronous execution and thrown errors. Captures COMMIT API return immediately after the native call, plus transaction sequence and allowlisted table/ID metadata. Autocommit write API returns are separately labelled. It does not replace SQLite, generate SQL, change returned business data, or print SQL/whole arguments/body text. Hook scope is this test profile's app.db. Manually executed db.exec transactions or write-returning get/all calls are not instrumented by this run wrapper.
- Transaction IDs group message/Work/operation/binding IDs from writes until COMMIT; nested savepoint release/rollback bookkeeping is recorded. Native-trigger message revisions are linked through the actual post-commit main broadcast's messageRevision, not invented from timestamps.
- Main: actual bot-work:message-changed send observation, message/request/conversation/revision/status/Work IDs.
- Renderer: official onMessageChanged callback and performance.mark; MutationObserver detects matching nonempty message text in actual [data-message-id]; rAF records full vertical inclusion in the thread/viewport. Markdown or later superseding revisions that do not match are not falsely counted as observed. DOM/viewport observations are not paint.
- Chromium: actual devtools Paint and DrawFrame events, with original pid/tid/ts/dur/args retained. Analyzer selects the first later Paint in the same renderer and a subsequent DrawFrame after that Paint ends.
- File open: observes only workspace:openFolder IPC and shell.openPath for targets inside the isolated HOME. operationId and exact test target path link shell return, IPC resolution/rejection and scenario UI notice. Original Promise identity and exceptions are preserved. Empty shell error means the OS accepted the request; it does not prove the external viewer displayed the content. The open extension was offline unit-tested with explicit stubs for success/rejection/identity, not a real-viewer claim.

## Zero-model real application validation

Successful real pnpm-dev/Electron run: /home/vivion/iq27-tmp/pz-1y4PON/evidence. Fresh profile models.providers={} and no API credentials inherited. Official sendMessage established a conversation but became unknown because no model was configured. This is recorded setup, not a model response. Official cron.upsert then created one timed pure reminder, which delivered through CronReminderDelivery to the actual UI. No model proxy existed. Checkpointed read-only DB counts: works 0, work_execution_bindings 0, task_request_diagnostics 0, task_tool_diagnostics 0, scope_tool_diagnostics 0.

Original trace: 13,276 events, 17 Paint, 256 DrawFrame, dataLossOccurred=false. Target reminder has COMMIT tx64/seq189 at monotonic ns 148619351023497, main broadcast seq190 at 148619351551925, renderer receive trace us 148619352228, DOM trace us 148619572817, visible-rAF trace us 148619573859, Paint start us 148619574226 with duration 335 us, DrawFrame us 148619575211. Renderer pid1560048, main pid1559878. Screenshot reminder.png is later visible-content evidence, not the first-paint timestamp.

Sixteen of sixteen named marks matched the trace. Each trace mark was bracketed by the runner's process.hrtime before/after CDP evaluate. Intersecting [before-traceTs, after-traceTs] gives offset bounds -373.442 to +614.878 us, width 988.320 us, with the stable same-host monotonic-clock assumption. Main and runner process.hrtime use the same host monotonic domain. This converts each latency into an interval, not fictitious nanosecond precision.

Target commit-to-receive 0.831–1.819 ms; commit-to-DOM 221.420–222.408 ms; commit-to-first-subsequent-Paint-start 222.829–223.817 ms; to that Paint end 223.164–224.152 ms. The Paint node is #document, nodeId1, with a clip covering the whole 2122x1363 viewport. This is not a proved target-message-specific first-pixel event. Actual physical display scanout/fsync were not measured. Do not call these measurements exact message-on-screen latency, durable-to-disk timing or an SLA. Other checks could share CPU during this feasibility run; it is not a clean performance baseline.

Measured SQLite hook metadata/enqueue overhead: 5.887 ms total across 223 instrumented calls. Renderer observer reported 18.300 ms over 322 scans/318 rAF frames. Main batch-flush I/O and Chromium tracing overhead are not included in those figures. No baseline subtraction or claimed zero perturbation.

Initial failed preflights remain preserved: pz-GYfjt3 failed before app startup because requiring electron directly from NODE_OPTIONS was too early; pz-8Dby4f completed the reminder but Chrome temporary trace-file export failed. Final collector uses supported Tracing.dataCollected instead. Neither failure was a model batch or a business result. The final streaming writer was separately tested by replaying the exact successful 13,276 raw diagnostic events into a new pc-N3qXS8 directory; byte semantics of event objects were deep-equal. The subsequent savepoint bookkeeping and file-open additions are identified as final offline-validated diagnostic changes, not silently claimed to have been in the original zero-model run.

All own launcher/main/renderer PIDs from the tests were independently checked absent after completion (1548760,1551744,1553294,1558129,1559878,1560048). The runner's cleanup owned list did not capture its process ancestry, so that empty list alone is not relied on. No user processes were stopped. A socket-list read was unavailable under the sandbox's netlink policy; no retry or workaround was made.

## Final script SHA-256

- main-probe.cjs 71d87fe97b226a14cb14aa0ccf7641ef0512971366e7c85f4ca10bc1916cd025
- collector.cjs f6e5d77894b21c6fd15aca7183236fea73212518b1be1177c9990bbd41407d8d
- bootstrap.cjs 2d6c82b4060fa38683e81fe380d03c8f0d097812d50e04650814d425379463ee
- analyze.cjs 93ddf16f8286800ff5a5e0ac7e6562997aa5d804653e9d0db002e6b2a33a80c2
- open-probe.cjs 384d4e786a1695d28a684bfd4812d58a494ebac6ba5514ce06755ab7c904a3a4
