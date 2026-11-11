# Bot history rendering: independent integrated verification, 2026-11-11

## Revision and scope

Product revision: **0b59e25aa0abf9eb836a4634a919345906848d49**. Integrated parent: **48e9e5a14e132f5749c3dd4dd0b1368673a76885**, whose only subsequent changes were the benchmark/report baseline-commit metadata correction. This acceptance adds a GUI test-fixture fix and this report; it does not change product code, issue #27 scheduling, user data, or Vivion work.

All checks ran in an independent Omarchy checkout with isolated test data. No product build or package was produced. Performance measurement was separated from aggregate-test load.

## Default and targeted results

- Dynamic classification: 476 default headless, 87 GUI, 41 NETWORK, 3 DATASET, 3 ARTIFACT, no pending tests. Classification audit passed.
- Unmodified default gate passed **476/476**, zero failures, zero known failures, zero new regressions, about 4.5 minutes. It passed once on the product revision and again after the GUI-fixture correction against the integrated parent. Exact selected and passed test-name sets were compared.
- Full web/node/scripts typecheck passed with zero errors. Test baseline and classification rules were unchanged.
- Hard-crash suites passed in the final run: Phase2 recovery 26.0s, Phase5 native story 13.4s, Gateway inbox crash 2.8s. Automatic, team, durable-session, session-history and execution-restart recovery also passed. These are isolated native-process fixtures, not physical-phone or packaged-app acceptance.
- Five actual Electron suites independently passed: concurrent conversation; Work conversation/navigation; message actions; history paging; scroll. They cover reverse receipts and streams, scoped stop/reply, Work detail/back and stale navigation, personal/team 100/100/50 history pages, multiple widths, anchors/focus, late image growth, keyboard/wheel reading and explicit resume.

## Independent native-input comparison

The real component/store/Markdown Electron fixture was rerun against **277188267e72ba193e6484cc33c70fd5d479d2af**. Source SHA-256 values were checked against Git. At 100/500/1,000 already-loaded synthetic messages, input-to-stable-frame medians were respectively **71.0→37.8ms**, **264.3→34.0ms**, and **486.4→29.0ms**. Each size has five native character-input observations.

All three complete transcript DOM hashes match. Draft edits render zero unchanged message components. Stream/name changes, independent child-store subscriptions, image preview and expanded local state remain functional. The final screenshot was inspected. At 1,000 messages, stream median remained **508.6→508.3ms** and one initial mount **2250.7→2253.8ms**; neither is claimed as an improvement. This measures synthetic renderer work with React development profiling, not database/IPC/provider latency or release SLOs.

## GUI-fixture failure found and fixed

The existing Work conversation GUI script reported success despite an unhandled `Invalid URL` exception. Its `empty` font loaders generated empty font URLs; Chromium exposed 60 resource-timing entries with an empty name. Electron 44.5.1's built-in insecure-resource diagnostic applies `new URL(name)` and threw from `node:electron/js2c/sandbox_bundle`. The application component was not the throwing code.

The fixture now emits real font files using esbuild's `file` loaders. The driver records current Electron console error events and asserts none at startup or after navigation. Negative control with the original empty-font bundle now exits **1** and identifies the exception. With the corrected fonts, the complete real-click suite exits **0** with no renderer errors. The ordinary development-only missing-CSP warning remains a warning; no security setting or error filter was disabled. Independent read-only review found no blocking issue and verified the Electron event API.

## Limits

This round independently covers five of 87 GUI suites; the other **82 GUI**, **41 NETWORK**, **3 DATASET**, and **3 ARTIFACT** suites were not run. Windows and physical devices were not independently tested. No cloud CI pass is implied by these local results. The implementation worker's additional GUI observations are documented separately in [the performance report](bot-history-draft-render-2026-11-11.md), not counted as this run's independent coverage.
