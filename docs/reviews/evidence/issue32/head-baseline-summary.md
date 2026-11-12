# Untouched HEAD comparison

HEAD: `d83532da7149e9d67fa7c1e68502864020fa488e`.

Created `baseline-src` with `git archive HEAD`, not a branch/worktree/reset/stash. The archive contains all 3,196 tracked files and needed resources/vendor/fixtures. Its SHA-256 is `f77b5f2fc480281c37b98b30d5f1ebcc95365dfe9128d3885dd17d8d2d732205`. Tests used a dependency junction to the existing repository `node_modules`; no install/rebuild or product build ran. Only existing `test:*` scripts compiled isolated test outputs.

All tracked snapshot files remain identical to the original tar after the tests. The sole Git-blob difference is Git archive's CRLF export of Android `gradlew.bat`; it is byte-identical to the tar entry. See `head-baseline-integrity.json`.

| HEAD test | Outcome | Observed cause |
| --- | --- | --- |
| architecture-graph | PASS | All five checks pass. The current collaboration import cycle was therefore a new issue. |
| bot-attachments | FAIL | Raw path assertion, `long human goal cannot truncate structured attachment input`. |
| bot-reminders | FAIL | `openPath` is undefined after earlier reminder blocks pass. |
| bot-report-images | FAIL | Alias count is 3 rather than 4. |
| bot-work-automatic-recovery | FAIL | Raw path assertion, `every recovery retains ancestral artifact path`. |
| cloudflared-cli-detect | FAIL | Expected absolute path has `C:`; actual path lost that prefix. |
| durable-artifact-registration | FAIL | Windows rejects file symlink creation with EPERM before remaining assertions. |
| durable-task-projection | FAIL | EPERM in temporary directory cleanup. The preceding functional body outcome is not established. |
| gadget-blueprint | FAIL | Windows rejects symlink creation with EPERM before remaining assertions. |
| gadget-runtime-lifecycle | FAIL | Actual exit signal is null, expected SIGTERM. |
| gateway-media | FAIL | Windows rejects directory symlink creation with EPERM before remaining assertions. |
| pinned-public-proxy | FAIL | Verified existing fake-IP proxy expectation is unmet. |
| session-history-recovery | FAIL | Isolated corrupt traversal exits 134 with no signal, outside the fixture's accepted outcomes. |
| slack-media | FAIL | Windows rejects symlink creation with EPERM before remaining assertions. |
| test-bundle-pool | FAIL | Fixture expected one compatible build; actual build count is three. |
| work-watch-supervision | FAIL | Several real supervision groups pass, then final assertion is 0 rather than 1. |

This proves 15 reported failures also occur on untouched HEAD under this Windows environment. It does not make the current full gate green and does not establish assertions blocked by OS setup/cleanup failures. No baseline whitelist entries or unrelated product repairs were added.

`head-baseline-results.json` records each command's code, log hash and tail. Complete logs are `head-<test-name>.log`. The collector's exit code 0 means collection finished; the individual test codes retain all failures.
