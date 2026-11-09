# Live tool feedback fixes

Baseline: f4e1fc5049778b0dcf537ead96178d221fc47fd0.

- `fetch_content` now sets `isError` for invalid requests, failed single-page extraction, and batches with no successful pages. Partial results stay available. No string-based error guessing and no SSRF changes.
- Progress-only `conversation_goal_update` can refresh a bookkeeping state version only against this conversation's last observed snapshot, with identical Work, lifecycle, intent, owner epoch, input snapshot, criteria and progress summary. Active-to-active is a no-op status. Actual concurrent content changes still conflict and return the latest snapshot/guard for reassessment. WorkService binding validation remains in force.

## Verification

- Typecheck: passed; scripts zero errors.
- Full headless suite: 397 passed, zero failed/known/regression.
- Registered progress-tool behavior tests: stale bookkeeping refresh succeeds; concurrent progress change remains untouched with fresh conflict metadata.
- Registered fetch tool: empty/invalid requests and single/batched blocked loopback targets return errors without fetching. Real extractor readable/raw/abort tests pass.
- Isolated Electron `pnpm dev` with real local DeepSeek V4.1 Flash: failed read of a missing file followed by successful directory creation, two 35-byte files, readback and comparison. Model fetched Goal once, then submitted progress using state version 10 after further tool activity. Update succeeded; persisted Work version 30 contains the actual readback summary. No production Work or credentials used.

## Remaining boundaries

Public weather extraction is still blocked on this host: its resolver returns `198.18.0.57` for `www.weather.com.cn`. This is a DNS fake-IP/SSRF conflict, not a model permission request. No network setting or address exemption was changed. A separately authorized proxy DNS change that returns real public addresses for intended domains can be evaluated while retaining SSRF checks.

Old weather recovery is not complete: `WorkAutomaticRecovery` readback mode deliberately delivers retained artifacts and then settles unsuccessfully rather than retrieving new facts. Future work should distinguish repeatable public reads from unknown write effects. These fixes do not change or clean up existing user Work records.
