# Incremental synchronization measurement

Status: not run. The user prohibited compilation while this script was being added. No benchmark numbers or GUI acceptance are claimed for the final source changes.

Prepared command, requiring permission to compile in a future task: `pnpm -s measure:durable-sync`.

The fixture imports 1,000 user/assistant turns, loads all 2,000 messages through native pagination, and records 100 runtime projection refreshes with storage scan counters. It then replays the same 100 growing active-message frames through full-snapshot and incremental transports. Both variants get equal warm-up, five measured runs with alternating order, separate initial snapshot size, transmitted bytes, sender and receiver timing, and unchanged storage scan counters. Results would be written to `artifacts/durable-unification/sync-benchmark.json`.

Sender timing includes delta construction and JSON serialization; receiver timing includes parsing and applying the update. This isolates transport and projection work, not provider time, whole-app frame rate, or a historical runtime build. No latency improvement is inferred from a zero scan count.

`scripts/durable-bot-desktop-test.cjs` now observes and reconstructs incremental events and checks that streamed events omit full message history. That updated GUI fixture has not been run.
