# Connector readiness honesty / 2026-11-11

## Scope

The connector service installs private skill packages; it does not install their CLI or authenticate their accounts. `available` in Bot settings means selectable, not a verified external connection. This change does not invent an inbox, a calendar integration, a connection test, or another approval workflow.

## Changes

- A shared connector fact block is supplied to Bot foreground and native task/Work instructions. It distinguishes registered skills, disabled/missing installation, and **unverified** CLI/authentication. Unverified does not mean signed out.
- Foreground reads a selected skill and uses an actually mounted applicable MCP tool, if one exists. A requested CLI operation is delegated to Work, where the existing tools can check runtime/account state according to the skill and then perform the requested operation. Merely listing capability metadata executes nothing.
- Hub, Bot settings, shared selection menu and Bot chips distinguish skill installation/reference from service authentication. Existing interfaces are reused.
- Current-platform CLI metadata no longer silently falls back to a Windows command on Linux/macOS.
- Historical conversations, credentials, production data, ordinary approval policy and external accounts are untouched.

## Verification

- `typecheck`: scripts 0 new errors.
- `test:skill-connector`: installation/private skills plus state facts, missing/disabled, case-insensitive selection dedup, no init/auth execution, current-platform command checks.
- `test:connector-id-case`: 5 passed.
- `test:bot-settings`: passed.

The live scenario is `pnpm -s test:bot-frontdoor:live -- --connector-readiness` with temporary HOME and actual Electron renderer/model transport. Six different foreground consultation tasks cover email query, calendar conflict, cloud file retrieval, overdue tasks, contact lookup and notes summarization. Each reads its actual on-disk test skill with `read_skill` and returns a file-only marker plus an honest unverified-account answer. The test packages are explicitly fixtures, not real signed-in services. No external email/calendar/account success is claimed. Native OS clicks are not covered; the actual renderer and preload/API are exercised through CDP.

The first live assertion rejected a correct answer phrased “是否已验证登录：没有 / required_not_verified”; its narrow regex was corrected to accept that truthful phrasing. This was a test assertion issue, not a service-authentication failure. The rerun uses a fresh isolated profile.

## Results

- Six real-model categories passed (12 native model calls; each category reads its selected skill, then responds). `opendesign/deepseek-v4.1-flash-eco`; initial complete run 10.4–11.5 seconds per task.
- Existing connector flyout and selected-chip status were asserted in the actual renderer; `connector-menu.png` visually inspected. Long status descriptions remain compact and expose their full text on hover.
- Non-fault default regression: **413 passed, 0 failed, 0 known, 0 new regressions**, 2.4 minutes. Only the previously deferred 20 crash/recovery suites were omitted through a temporary runner; official runner/baseline unchanged.
- No external-service credential/login test, remote service API operation, native OS picker/input, packaged application or production instance was tested or modified in this change. Actual connector CLI operation success remains dependent on a configured service and actual receipts, not these synthetic documentation fixtures.

A second six-category live run also passed after the UI tooltip/fixture refresh refinement. Empty connector selection bypasses catalog enumeration, so ordinary requests do not pay an extra connector scan. Current successful tool receipts can be reused rather than rechecking authentication on every call.
